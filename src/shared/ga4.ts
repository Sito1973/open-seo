/** Better Auth provider ID for the dedicated Google Analytics grant. */
export const GA4_OAUTH_PROVIDER_ID = "google-analytics";

export const GA4_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/analytics.readonly",
] as const;

/** Lets update_google_analytics_key_event change a property's key events.
 *  Only self-hosted installs ask for it; hosted grants stay read-only. */
export const GA4_EDIT_SCOPE = "https://www.googleapis.com/auth/analytics.edit";

export const GA4_SELF_HOSTED_SETUP_DOCS_URL =
  "https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_ANALYTICS.md";
