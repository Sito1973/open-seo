import { z } from "zod";
import { GooglePlacesUsageRepository } from "@/server/features/google-places/repositories/GooglePlacesUsageRepository";
import { AppError } from "@/server/lib/errors";
import {
  getOptionalEnvValue,
  isHostedServerAuthMode,
} from "@/server/lib/runtime-env";
import { formatUsd } from "@/shared/format";
import {
  DEFAULT_TREG_MONTHLY_BUDGET_USD,
  parseTregMonthlyBudgetUsd,
} from "@/shared/selfhost-checks";

// treg (https://treg.to) resells, call by call, data OpenSEO has no other
// source for: a competitor's Instagram, and the ads a Facebook page runs from
// the Meta Ad Library. It bills the operator's prepaid treg balance, so it
// runs on self-hosted installs only, with or without DataForSEO. The URL is a
// fixed provider host, so no SSRF screening applies.
const CALL_URL = "https://treg.to/call/";
// treg tries providers in turn, and its slowest took over a minute in tests.
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * The most one call may cost, in millionths of a US dollar. Every request
 * sends it as X-Treg-Route-Max-Cost, without which a routed call may pay
 * providers in turn up to treg's default of $1, and reserves it from the
 * monthly budget before it is sent.
 */
const CALL_CEILING_MICRO = 10_000;
const SKU = "treg_usd_micro";
const MICRO_PER_USD = 1_000_000;

export const TREG_NOT_CONFIGURED =
  "treg is not configured on this server: set TREG_API_KEY on a self-hosted install. See docs/SELF_HOSTING_GOOGLE_APIS.md.";

/** TREG_API_KEY on a self-hosted install: null on hosted, or when unset. */
export async function getTregKey(): Promise<string | null> {
  if (await isHostedServerAuthMode()) return null;
  return (await getOptionalEnvValue("TREG_API_KEY")) ?? null;
}

function budgetMonth() {
  return new Date().toISOString().slice(0, 7);
}

/** TREG_MONTHLY_BUDGET_USD in millionths of a dollar, or null when invalid. */
async function monthlyLimitMicro(): Promise<number | null> {
  const usd = parseTregMonthlyBudgetUsd(
    await getOptionalEnvValue("TREG_MONTHLY_BUDGET_USD"),
  );
  return usd === null ? null : Math.round(usd * MICRO_PER_USD);
}

/**
 * This month's (UTC) treg spend as this server counted it, against its
 * budget, in US dollars. Null while TREG_MONTHLY_BUDGET_USD is invalid.
 */
export async function getTregBudget() {
  const limitMicro = await monthlyLimitMicro();
  if (limitMicro === null) return null;
  const usedMicro = await GooglePlacesUsageRepository.usedCalls({
    month: budgetMonth(),
    sku: SKU,
  });
  return {
    usedUsd: usedMicro / MICRO_PER_USD,
    limitUsd: limitMicro / MICRO_PER_USD,
  };
}

/** What one call cost, and where the month's budget stands after it. */
export type TregCharge = {
  /** What treg charged for the call, in US dollars. */
  chargedUsd: number;
  /**
   * The provider endpoint that answered: the one treg routed the call to, or
   * the tool itself when it is a provider's own.
   */
  servedBy: string | null;
  /** treg's id of the call, to quote when asking treg about it. */
  callId: string | null;
  budget: { usedUsd: number; limitUsd: number; resets: string };
};

export function tregChargeLine(charge: TregCharge): string {
  const served = charge.servedBy ? `, served by ${charge.servedBy}` : "";
  return `treg charged ${formatUsd(charge.chargedUsd)} for this call${served}. treg budget: ${formatUsd(charge.budget.usedUsd)} of ${formatUsd(charge.budget.limitUsd)} used this month (resets on ${charge.budget.resets}).`;
}

// treg's own refusals carry {detail: {error, message}}; a relayed provider
// error can carry anything.
const errorBodySchema = z.object({
  detail: z.union([
    z.string(),
    z.object({
      error: z.string().optional(),
      message: z.string().optional(),
    }),
  ]),
});

function httpError(status: number, body: unknown, apiKey: string): AppError {
  const parsed = errorBodySchema.safeParse(body);
  const detail = parsed.success ? parsed.data.detail : null;
  const code = typeof detail === "object" ? detail?.error : undefined;
  const message = (
    (typeof detail === "string" ? detail : detail?.message) ?? `HTTP ${status}`
  )
    .replaceAll(apiKey, "<api key>")
    .slice(0, 300);
  console.warn(`[treg] HTTP ${status}${code ? ` ${code}` : ""}: ${message}`);

  if (code === "route_max_cost") {
    return new AppError(
      "UPSTREAM_UNAVAILABLE",
      `treg has no provider for this call within this server's ceiling of ${formatUsd(CALL_CEILING_MICRO / MICRO_PER_USD)} a call, so nothing was sent or charged.`,
    );
  }
  if (status === 402 || code === "funds_required") {
    return new AppError(
      "TREG_BILLING_ISSUE",
      `treg's prepaid balance is too low for this call${code ? ` (${code})` : ""}, so nothing was charged. Top up the treg account at treg.to, then retry.`,
    );
  }
  if (status === 401 || status === 403) {
    // An unknown key answers 401 "invalid token".
    return new AppError(
      "AUTH_CONFIG_MISSING",
      `treg refused the call (${code ? `${code}: ` : ""}${message.replace(/\.$/, "")}). Check TREG_API_KEY.`,
    );
  }
  if (status === 400 || status === 422) {
    return new AppError(
      "VALIDATION_ERROR",
      `treg rejected the request: ${message}`,
    );
  }
  if (status === 404) return new AppError("NOT_FOUND", `treg: ${message}`);
  if (status === 429) return new AppError("RATE_LIMITED", `treg: ${message}`);
  return new AppError("UPSTREAM_UNAVAILABLE", `treg: ${message}`);
}

/**
 * What treg says the call cost, from X-Treg-Cost-Micro. Without the header a
 * refused or failed call is free, as treg bills none of them, and an answered
 * one counts as the whole ceiling: the safe direction.
 */
function chargedMicro(response: Response): number {
  const header = response.headers.get("X-Treg-Cost-Micro")?.trim();
  if (header && /^\d{1,9}$/.test(header)) return Number(header);
  return response.ok ? CALL_CEILING_MICRO : 0;
}

/**
 * Replaces the ceiling reserved for a call with what treg charged, and
 * returns the month's spend after it. A failed write is logged, never thrown:
 * the call is already paid for, and the counter then over-counts by the
 * unused part of the ceiling, the safe direction.
 */
async function settle(month: string, reservedTotal: number, charged: number) {
  const delta = charged - CALL_CEILING_MICRO;
  if (delta === 0) return reservedTotal;
  try {
    const total = await GooglePlacesUsageRepository.adjustCalls({
      month,
      sku: SKU,
      delta,
    });
    return total ?? reservedTotal;
  } catch (error) {
    console.error("[treg] correcting the monthly spend failed:", error);
    return reservedTotal;
  }
}

/**
 * One call to a treg catalog tool, with the per-call ceiling always set. The
 * ceiling is reserved from the monthly budget before the request is sent, so
 * a call past the budget sends nothing, and corrected to what treg charged
 * once it answers. A request whose answer is lost keeps the whole ceiling
 * counted, because treg may have charged it.
 */
export async function callTreg<T>(
  apiKey: string,
  input: {
    /** A treg catalog tool id, such as treg.instagram.user.profile. */
    tool: string;
    body: Record<string, unknown>;
    schema: z.ZodType<T>;
    /**
     * Pay one provider only instead of trying the next one on a miss: for
     * routed tools where every provider bills a miss.
     */
    singleProvider?: boolean;
  },
): Promise<{ data: T; charge: TregCharge }> {
  const limitMicro = await monthlyLimitMicro();
  if (limitMicro === null) {
    // Setup the owner acts on, like a missing key: not a bug to report.
    throw new AppError(
      "PROVIDER_NOT_CONFIGURED",
      `treg is switched off on this server: TREG_MONTHLY_BUDGET_USD is not an amount in US dollars above 0 with at most two decimals, such as 2 or 2.50. Fix it, or remove it for the default of ${formatUsd(DEFAULT_TREG_MONTHLY_BUDGET_USD)}. No call was sent.`,
    );
  }
  const month = budgetMonth();
  const reservedTotal = await GooglePlacesUsageRepository.reserveCalls({
    month,
    sku: SKU,
    count: CALL_CEILING_MICRO,
    limit: limitMicro,
  });
  if (reservedTotal == null) {
    throw new AppError(
      "MONTHLY_BUDGET_EXHAUSTED",
      `This server's monthly treg budget (${formatUsd(limitMicro / MICRO_PER_USD)} in ${month}, UTC) has less than ${formatUsd(CALL_CEILING_MICRO / MICRO_PER_USD)} left, the most one call may cost, so no call was sent. It resets on the 1st; TREG_MONTHLY_BUDGET_USD sets it.`,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${CALL_URL}${input.tool}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A header, so the key stays out of logged URLs.
        "X-Treg-Token": apiKey,
        "X-Treg-Route-Max-Cost": String(CALL_CEILING_MICRO / MICRO_PER_USD),
        ...(input.singleProvider ? { "X-Treg-Route-Waterfall": "0" } : {}),
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Only the error's name: nothing of the request belongs in the logs.
    console.warn(
      "[treg] request failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      error instanceof Error && error.name === "TimeoutError"
        ? `treg did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. It may still have charged the call, so its full ceiling stays counted against the monthly budget.`
        : "treg could not be reached.",
    );
  }

  // Settle before reading the body, so a charged answer that fails to parse
  // is still counted at what it cost.
  const charged = chargedMicro(response);
  const usedMicro = await settle(month, reservedTotal, charged);
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) throw httpError(response.status, json, apiKey);

  const parsed = input.schema.safeParse(json);
  if (!parsed.success) {
    console.warn("[treg] unexpected response:", parsed.error.message);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "treg returned an unexpected response.",
    );
  }
  return {
    data: parsed.data,
    charge: {
      chargedUsd: charged / MICRO_PER_USD,
      servedBy:
        response.headers.get("X-Treg-Served-By") ??
        (input.tool.startsWith("treg.") ? null : input.tool),
      callId: response.headers.get("X-Treg-Call-Id"),
      budget: {
        usedUsd: usedMicro / MICRO_PER_USD,
        limitUsd: limitMicro / MICRO_PER_USD,
        resets: "the 1st, UTC",
      },
    },
  };
}
