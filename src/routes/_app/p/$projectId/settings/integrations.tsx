import { queryClient } from "@/client/tanstack-db/queryClient";
import { googleConnectionOptions } from "@/client/features/integrations/googleProviders";
import { createFileRoute } from "@tanstack/react-router";
import { GoogleAdsCard } from "@/client/features/integrations/GoogleAdsCard";
import { GoogleConnectionCard } from "@/client/features/integrations/GoogleConnectionCard";
import { CrawlerAccessSettings } from "@/client/features/settings/CrawlerAccessSettings";
import { isHostedClientAuthMode } from "@/lib/auth-mode";

export const Route = createFileRoute(
  "/_app/p/$projectId/settings/integrations",
)({
  loader: ({ params }) => {
    // Start the database checks on link intent without holding up navigation.
    void queryClient.prefetchQuery(
      googleConnectionOptions("gsc", params.projectId),
    );
    void queryClient.prefetchQuery(
      googleConnectionOptions("ga4", params.projectId),
    );
    if (!isHostedClientAuthMode()) {
      void queryClient.prefetchQuery(
        googleConnectionOptions("gbp", params.projectId),
      );
    }
  },
  component: ProjectIntegrationsRoute,
});

function ProjectIntegrationsRoute() {
  const { projectId } = Route.useParams();

  return (
    <div className="space-y-8">
      {/* The ids are the targets old #search-console / #google-analytics deep
          links are redirected to from the settings index. Each card's title
          names its integration, so the sections carry no heading. */}
      <section id="search-console" className="scroll-mt-6">
        <GoogleConnectionCard provider="gsc" projectId={projectId} />
      </section>

      <section id="google-analytics" className="scroll-mt-6">
        <GoogleConnectionCard provider="ga4" projectId={projectId} />
      </section>

      {/* Self-hosted only: the MCP tools link here (#business-profile). */}
      {isHostedClientAuthMode() ? null : (
        <section id="business-profile" className="scroll-mt-6">
          <GoogleConnectionCard provider="gbp" projectId={projectId} />
        </section>
      )}

      {/* Self-hosted only: Keyword Planner errors send users here to
          connect Google Ads. */}
      {isHostedClientAuthMode() ? null : (
        <section id="google-ads" className="scroll-mt-6 empty:hidden">
          <GoogleAdsCard />
        </section>
      )}

      <CrawlerAccessSettings projectId={projectId} />
    </div>
  );
}
