/** Better Auth provider ID for the dedicated Google Ads grant. */
export const GOOGLE_ADS_OAUTH_PROVIDER_ID = "google-ads";

// adwords is Google Ads' only API scope and it is write-capable. OpenSEO only
// calls the Keyword Planner and a read-only geo target lookup with it.
export const GOOGLE_ADS_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/adwords",
] as const;

export const GOOGLE_ADS_SETUP_DOCS_URL =
  "https://github.com/Sito1973/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_APIS.md#google-ads-keyword-planner-search-volume-and-keyword-ideas";
