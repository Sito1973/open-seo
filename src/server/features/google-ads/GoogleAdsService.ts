import { GoogleAdsGrantRepository } from "@/server/features/google-ads/GoogleAdsGrantRepository";
import {
  createGoogleAuthorizationUrl,
  GOOGLE_ADS_INTEGRATION,
} from "@/server/features/google/googleOAuth";
import {
  getGoogleOAuthClientConfig,
  hasGoogleOAuthConfig,
} from "@/server/features/google/oauth-config";
import { AppError } from "@/server/lib/errors";
import { getKeywordPlannerConfig } from "@/server/lib/keywordPlannerConfig";
import {
  getDataforseoKey,
  isHostedServerAuthMode,
} from "@/server/lib/runtime-env";

// The Google Ads grant behind the self-hosted Keyword Planner. Self-hosted
// only: the adwords scope is write-capable, so every entry point refuses
// hosted mode before doing anything else.

async function requireSelfHosted() {
  if (await isHostedServerAuthMode()) {
    throw new AppError(
      "NOT_FOUND",
      "Google Ads is available on self-hosted installs only.",
    );
  }
}

async function getStatus(userId: string) {
  await requireSelfHosted();
  const [dataforseoKey, plannerConfig, oauthConfigured, grant] =
    await Promise.all([
      getDataforseoKey("other"),
      getKeywordPlannerConfig(),
      getGoogleOAuthClientConfig("ads").then(hasGoogleOAuthConfig),
      GoogleAdsGrantRepository.getLatestGrant(userId),
    ]);
  return {
    // DataForSEO serves keyword data whenever this server uses it beyond
    // backlinks.
    available: !dataforseoKey,
    plannerActive: plannerConfig !== null,
    oauthConfigured,
    connected: grant !== null,
  };
}

async function startLink(input: {
  userId: string;
  callbackURL: string;
  publicOrigin: string;
}) {
  await requireSelfHosted();
  return createGoogleAuthorizationUrl({
    integration: GOOGLE_ADS_INTEGRATION,
    ...input,
  });
}

/** Removes the stored grant; access can also be revoked in the Google account. */
async function disconnect(userId: string) {
  await requireSelfHosted();
  await GoogleAdsGrantRepository.removeGrants(userId);
}

export const GoogleAdsService = { getStatus, startLink, disconnect };
