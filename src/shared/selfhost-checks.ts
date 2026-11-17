import { formatUsd } from "@/shared/format";

// Pure validators for self-host configuration values. Shared by the runtime
// (auth middleware, /api/health, telemetry) and the Docker preflight script,
// so every surface applies the exact same rules and wording.

export const MIN_BETTER_AUTH_SECRET_LENGTH = 32;

type TeamDomainResult =
  | { ok: true; origin: string }
  | { ok: false; message: string };

export function validateTeamDomain(value: string): TeamDomainResult {
  const normalized = value.trim().replace(/\/+$/, "");

  try {
    const parsed = new URL(normalized);

    if (parsed.protocol !== "https:") {
      throw new Error("TEAM_DOMAIN must use https");
    }

    return { ok: true, origin: parsed.origin };
  } catch {
    return {
      ok: false,
      message:
        "TEAM_DOMAIN must be a full https URL like https://your-team.cloudflareaccess.com" +
        (normalized && !normalized.includes("://")
          ? ` — add the https:// prefix to "${normalized}"`
          : ""),
    };
  }
}

// DATAFORSEO_API_KEY is NOT the key shown in the DataForSEO dashboard — it is
// base64("login:password"). Decoding it and finding a colon is a cheap sanity
// check that catches the most common paste mistake without a paid API call.
export function looksLikeDataForSeoKey(value: string): boolean {
  try {
    return atob(value.trim()).includes(":");
  } catch {
    return false;
  }
}

// DATAFORSEO_SCOPE=backlinks: each Backlinks API request takes one request of
// a monthly budget and may ask for at most 1,000 rows (DataForSEO's own
// maximum), so the budget bounds what a month can cost.
export const DEFAULT_BACKLINKS_MONTHLY_REQUESTS = 300;
export const BACKLINKS_MAX_ROWS_PER_REQUEST = 1000;

// DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS: the default when unset, null when it
// is not a whole number above 0.
export function parseBacklinksMonthlyRequests(
  value: string | undefined,
): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_BACKLINKS_MONTHLY_REQUESTS;
  return /^[1-9]\d{0,6}$/.test(trimmed) ? Number(trimmed) : null;
}

// TREG_API_KEY: treg bills its prepaid balance for each call, so a monthly
// budget in US dollars (UTC) bounds what a month can cost.
export const DEFAULT_TREG_MONTHLY_BUDGET_USD = 2;

// TREG_MONTHLY_BUDGET_USD: the default when unset, null when it is not an
// amount above 0 and up to 1,000 with at most two decimals, such as 2 or 2.50.
export function parseTregMonthlyBudgetUsd(
  value: string | undefined,
): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_TREG_MONTHLY_BUDGET_USD;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(trimmed)) return null;
  const usd = Number(trimmed);
  return usd > 0 && usd <= 1000 ? usd : null;
}

// The startup check for treg, which hosted never reads. A bad budget only
// warns: the Instagram and Meta ad tools then send nothing, and the rest of
// the app does not depend on them.
export function tregSetupChecks(env: Record<string, string | undefined>) {
  if (env.AUTH_MODE?.trim() === "hosted") return [];
  const key = "treg" as const;
  if (!env.TREG_API_KEY?.trim()) {
    return [
      {
        key,
        name: "Instagram and Meta ads",
        level: "info" as const,
        message:
          "TREG_API_KEY not set (optional) — the Instagram and Meta ad MCP tools are off. A treg (treg.to) key turns them on, under a monthly budget in US dollars. See docs/SELF_HOSTING_GOOGLE_APIS.md.",
      },
    ];
  }
  const budget = parseTregMonthlyBudgetUsd(env.TREG_MONTHLY_BUDGET_USD);
  return [
    budget === null
      ? {
          key,
          name: "TREG_MONTHLY_BUDGET_USD",
          level: "warn" as const,
          message: `Must be an amount in US dollars above 0 and up to 1,000, such as 2 or 2.50, or unset for the default of ${formatUsd(DEFAULT_TREG_MONTHLY_BUDGET_USD)}. The Instagram and Meta ad tools send nothing until it is fixed.`,
        }
      : {
          key,
          name: "Instagram and Meta ads",
          level: "ok" as const,
          message: `TREG_API_KEY set — treg calls stop at ${formatUsd(budget)} a month (UTC), and no call may cost more than $0.01.`,
        },
  ];
}

// OPENSEO_TELEMETRY_DISABLED / DO_NOT_TRACK semantics: any value except an
// explicit "off" string disables telemetry (fail toward privacy), but
// "0"/"false"/"no"/"off" mean what the operator wrote — telemetry stays on.
export function isTelemetryOptOutValue(
  value: string | undefined | null,
): boolean {
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
