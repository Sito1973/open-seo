/** Better Auth provider ID for the dedicated Google Business Profile grant. */
export const GBP_OAUTH_PROVIDER_ID = "google-business-profile";

// business.manage is the only Business Profile scope and it is write-capable.
// OpenSEO reads with it, and writes only through the Business Profile edit
// tools after a preview the user approves.
export const GBP_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/business.manage",
] as const;

export const GBP_SELF_HOSTED_SETUP_DOCS_URL =
  "https://github.com/Sito1973/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_BUSINESS_PROFILE.md";
