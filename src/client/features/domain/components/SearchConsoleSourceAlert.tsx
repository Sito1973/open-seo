import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import type { SearchConsoleSource } from "@/server/features/domain/services/searchConsoleDomain";

/**
 * Explains Domain Overview numbers on a self-hosted install that reads them
 * from Google Search Console instead of DataForSEO.
 */
export function SearchConsoleSourceAlert({
  source,
}: {
  source: SearchConsoleSource;
}) {
  return (
    <Alert variant="info">
      <Info />
      <AlertDescription className="text-foreground">
        {source.siteUrl
          ? `Your own site, from Google Search Console (${source.siteUrl}), ${source.startDate} to ${source.endDate}, all countries. Traffic is real clicks. Search Console leaves out rare queries, so the keyword count is a minimum.`
          : `This server reads Domain Overview data from Google Search Console, so it covers only sites connected to a project in this organization${
              source.connectedSites.length > 0
                ? ` (${source.connectedSites.join(", ")})`
                : ""
            }. Connect a site's property under the project's Settings → Integrations.`}
      </AlertDescription>
    </Alert>
  );
}
