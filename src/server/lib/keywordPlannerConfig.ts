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
  "Source: Google Ads Keyword Planner through this server's Google Ads account. It has no keyword difficulty or intent, and CPC stays empty because Google reports bids in the Ads account's currency.";

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
