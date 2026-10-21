import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { GoogleAdsService } from "@/server/features/google-ads/GoogleAdsService";
import { getPublicOrigin } from "@/server/mcp/public-origin";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";

// The user's own Google Ads grant for the Keyword Planner, self-hosted only:
// GoogleAdsService refuses hosted mode.

const startLinkSchema = z.object({ callbackURL: z.string().min(1) });

export const getGoogleAdsConnection = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(({ context }) => GoogleAdsService.getStatus(context.userId));

export const startGoogleAdsLink = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(startLinkSchema)
  .handler(async ({ data, context }) => ({
    url: await GoogleAdsService.startLink({
      userId: context.userId,
      callbackURL: data.callbackURL,
      publicOrigin: getPublicOrigin(getRequest()),
    }),
  }));

export const disconnectGoogleAds = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    await GoogleAdsService.disconnect(context.userId);
    return { connected: false as const };
  });
