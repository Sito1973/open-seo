import {
  getGoogleFallbackKey,
  getOptionalEnvValue,
} from "@/server/lib/runtime-env";

export type KeywordPlannerConfig = {
  customerId: string;
  /** Set when the grant reaches the account through a manager account. */
  loginCustomerId: string | null;
};

export const KEYWORD_PLANNER_SOURCE_NOTE =
  "Source: Google Ads Keyword Planner through this server's Google Ads account. It has no keyword difficulty. CPC is Google's average CPC (or the midpoint of its top-of-page bids) converted to USD from the account's currency, at the day's official Colombian rate for a peso account. Intent for Spanish keywords comes from OpenSEO's own word rules and the project's brands, not from Google; it stays unknown when no rule matches, and other languages get none.";

// Google shows customer IDs as 123-456-7890; the API takes the digits.
function digits(customerId: string) {
  return customerId.replaceAll("-", "").trim();
}

/**
 * The Google Ads account the Keyword Planner reads, on self-hosted installs
 * only: null on hosted, next to DATAFORSEO_API_KEY, or unless
 * GOOGLE_ADS_CUSTOMER_ID and the Google Ads OAuth client are set.
 */
export async function getKeywordPlannerConfig(): Promise<KeywordPlannerConfig | null> {
  const customerId = await getGoogleFallbackKey("GOOGLE_ADS_CUSTOMER_ID");
  if (!customerId) return null;
  const [loginCustomerId, clientId, clientSecret] = await Promise.all([
    getOptionalEnvValue("GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
    getOptionalEnvValue("GOOGLE_ADS_CLIENT_ID"),
    getOptionalEnvValue("GOOGLE_ADS_CLIENT_SECRET"),
  ]);
  if (!clientId || !clientSecret) return null;
  return {
    customerId: digits(customerId),
    loginCustomerId: loginCustomerId ? digits(loginCustomerId) : null,
  };
}
