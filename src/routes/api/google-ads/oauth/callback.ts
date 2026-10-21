import { createFileRoute } from "@tanstack/react-router";
import {
  GOOGLE_ADS_INTEGRATION,
  handleGoogleOAuthCallbackRequest,
} from "@/server/features/google/googleOAuth";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";

export const Route = createFileRoute("/api/google-ads/oauth/callback")({
  server: {
    handlers: {
      // Google Ads is self-hosted only, so hosted never stores its
      // write-capable grant.
      GET: async ({ request }: { request: Request }) =>
        (await isHostedServerAuthMode())
          ? new Response("Not Found", { status: 404 })
          : handleGoogleOAuthCallbackRequest(request, GOOGLE_ADS_INTEGRATION),
    },
  },
});
