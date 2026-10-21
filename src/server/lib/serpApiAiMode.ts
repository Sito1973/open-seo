import { z } from "zod";
import { GooglePlacesUsageRepository } from "@/server/features/google-places/repositories/GooglePlacesUsageRepository";
import { AppError } from "@/server/lib/errors";
import { getGoogleFallbackKey } from "@/server/lib/runtime-env";
import { aiCountryLabel } from "@/shared/ai-visibility";
import { getIsoCountryCode } from "@/shared/keyword-locations";

// SerpApi's Google AI Mode API: the AI Mode answer for one search, on
// self-hosted installs without DataForSEO. Both URLs are fixed provider hosts,
// so no SSRF screening applies. SerpApi takes the key only as a query
// parameter, so these URLs are never logged.
// https://serpapi.com/google-ai-mode-api
const SEARCH_URL = "https://serpapi.com/search.json";
// https://serpapi.com/account-api (free: it uses no search)
const ACCOUNT_URL = "https://serpapi.com/account.json";
// An AI Mode answer took about 8 seconds in tests.
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Hard-coded below the free plan's 250 searches a month so this server never
 * needs a paid plan. There is deliberately no setting to raise it. Every
 * tracker on this server shares it.
 */
export const SERPAPI_MONTHLY_BUDGET = 240;
/**
 * The free plan's throughput: 50 searches an hour
 * (https://serpapi.com/pricing). A check must fit in one hour.
 */
export const SERPAPI_HOURLY_LIMIT = 50;

const errorBodySchema = z.object({ error: z.string().max(1_000) });
const searchSchema = z.looseObject({
  search_metadata: z.object({ status: z.string() }),
  error: z.string().max(1_000).optional(),
});
const accountSchema = z.object({
  plan_searches_left: z.number(),
  account_rate_limit_per_hour: z.number(),
  this_hour_searches: z.number(),
});

/**
 * SerpApi collects Google AI Mode answers on self-hosted installs only: null
 * on hosted, next to DATAFORSEO_API_KEY, or without SERPAPI_API_KEY.
 */
export function getSerpApiKey(): Promise<string | null> {
  return getGoogleFallbackKey("SERPAPI_API_KEY");
}

/**
 * The budget's month, UTC. SerpApi's plan month starts on the signup date
 * instead, so a check also reads SerpApi's own count (fetchSerpApiAccount).
 */
function budgetMonth() {
  return new Date().toISOString().slice(0, 7);
}

/** Searches this server counted this month (UTC). */
export function serpApiSearchesUsed(): Promise<number> {
  return GooglePlacesUsageRepository.usedCalls({
    month: budgetMonth(),
    sku: "serpapi",
  });
}

/** SerpApi's error text, without the key in case it is ever echoed. */
async function errorDetail(response: Response, apiKey: string) {
  const body = errorBodySchema.safeParse(
    await response.json().catch(() => null),
  );
  return (body.success ? body.data.error : `HTTP ${response.status}`)
    .replaceAll(apiKey, "<api key>")
    .slice(0, 300);
}

/**
 * SerpApi's own count of the searches left this plan cycle and this hour, or
 * null when it cannot be read: the local budget still guards every search.
 */
export async function fetchSerpApiAccount(apiKey: string) {
  try {
    const response = await fetch(
      `${ACCOUNT_URL}?${new URLSearchParams({ api_key: apiKey })}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const account = accountSchema.safeParse(
      response.ok ? await response.json() : null,
    );
    if (!account.success) {
      console.warn(`[serpapi] account read failed (HTTP ${response.status})`);
      return null;
    }
    return {
      planSearchesLeft: account.data.plan_searches_left,
      // Never above the free plan's hourly limit, whatever the account says.
      hourSearchesLeft:
        Math.min(
          account.data.account_rate_limit_per_hour,
          SERPAPI_HOURLY_LIMIT,
        ) - account.data.this_hour_searches,
    };
  } catch (error) {
    // Only the error's name: a fetch error could carry the URL, and the key.
    console.warn(
      "[serpapi] account read failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return null;
  }
}

/**
 * The Google AI Mode answer for one prompt, asked from the market's country
 * in its language, as SerpApi's raw JSON. One search is reserved from the
 * monthly budget before it is sent; failed searches stay counted, the safe
 * direction. SerpApi serves a repeat of the same search within an hour from
 * its cache without using a search; it is still counted here.
 */
export async function fetchSerpApiAiMode(
  apiKey: string,
  input: { prompt: string; locationCode: number; languageCode: string },
): Promise<unknown> {
  const month = budgetMonth();
  const used = await GooglePlacesUsageRepository.reserveCalls({
    month,
    sku: "serpapi",
    count: 1,
    limit: SERPAPI_MONTHLY_BUDGET,
  });
  if (used == null)
    throw new AppError(
      "MONTHLY_BUDGET_EXHAUSTED",
      `This server's monthly SerpApi budget (${SERPAPI_MONTHLY_BUDGET} searches in ${month}, UTC) is used up, so no search was sent. It resets on the 1st.`,
    );

  const params = new URLSearchParams({
    engine: "google_ai_mode",
    q: input.prompt,
    // A country-level location; Google's country names match the market list.
    location: aiCountryLabel(input.locationCode),
    gl: getIsoCountryCode(input.locationCode),
    hl: input.languageCode,
    api_key: apiKey,
  });
  let response: Response;
  try {
    response = await fetch(`${SEARCH_URL}?${params}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(
      "[serpapi] search failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      error instanceof Error && error.name === "TimeoutError"
        ? `SerpApi did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
        : "SerpApi could not be reached.",
    );
  }
  if (!response.ok) {
    const detail = await errorDetail(response, apiKey);
    console.warn(`[serpapi] HTTP ${response.status}: ${detail}`);
    if (response.status === 401)
      throw new AppError(
        "AUTH_CONFIG_MISSING",
        `SerpApi refused SERPAPI_API_KEY: ${detail}`,
      );
    throw new AppError(
      response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
      `SerpApi: ${detail}`,
    );
  }
  const body: unknown = await response.json().catch(() => null);
  const search = searchSchema.safeParse(body);
  // A finished search with an error field and no answer means Google showed
  // no AI Mode answer; the parser reads it as a no-answer result.
  if (!search.success || search.data.search_metadata.status !== "Success") {
    const detail = search.success
      ? (search.data.error ?? search.data.search_metadata.status).replaceAll(
          apiKey,
          "<api key>",
        )
      : "unexpected response";
    console.warn(`[serpapi] search did not finish: ${detail}`);
    throw new AppError("UPSTREAM_UNAVAILABLE", `SerpApi: ${detail}`);
  }
  return body;
}
