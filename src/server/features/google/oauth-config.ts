import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { MIN_BETTER_AUTH_SECRET_LENGTH } from "@/shared/selfhost-checks";

type GoogleOAuthClientConfig = {
  clientId: string;
  clientSecret: string;
};

/**
 * Which OAuth client a grant uses. Google Ads has its own: its API access
 * level belongs to the Google Cloud project that owns the OAuth client.
 */
export type GoogleOAuthClient = "default" | "ads";

const CLIENT_ENV = {
  default: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  ads: ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET"],
} as const;

export async function getGoogleOAuthClientConfig(
  client: GoogleOAuthClient = "default",
): Promise<GoogleOAuthClientConfig | null> {
  const [idName, secretName] = CLIENT_ENV[client];
  const clientId = (await getOptionalEnvValue(idName))?.trim();
  const clientSecret = (await getOptionalEnvValue(secretName))?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Search Console and Analytics need a Google OAuth client plus the secret
 *  that encrypts stored tokens. Hosted deployments always have both. */
export async function hasGoogleOAuthConfig(
  config?: GoogleOAuthClientConfig | null,
): Promise<boolean> {
  const oauthConfig =
    config === undefined ? await getGoogleOAuthClientConfig() : config;
  if (!oauthConfig) return false;
  const secret = (await getOptionalEnvValue("BETTER_AUTH_SECRET"))?.trim();
  return Boolean(secret && secret.length >= MIN_BETTER_AUTH_SECRET_LENGTH);
}
