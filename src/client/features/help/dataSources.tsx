import { queryOptions, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Unplug } from "lucide-react";
import { EmptyState } from "@/client/components/EmptyState";
import { Button } from "@/client/components/ui/button";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import { getDataSourcesStatus } from "@/serverFunctions/config";
import { hasDataSource, type DataSection } from "@/shared/data-sources";

// What serves each section on a self-hosted server without DataForSEO. The
// server answers null on hosted and wherever DataForSEO serves every
// feature; hosted never asks.
const dataSourcesQueryOptions = () =>
  queryOptions({
    queryKey: ["dataSources"],
    queryFn: () => getDataSourcesStatus(),
    staleTime: 60_000,
  });

export function useDataSources(enabled = true) {
  return useQuery({
    ...dataSourcesQueryOptions(),
    enabled: enabled && !isHostedClientAuthMode(),
  });
}

/** The app paths of sections that have no source on this server. */
export function pathsWithoutSource(
  sections: DataSection[] | undefined,
): Set<string> {
  return new Set(
    (sections ?? []).flatMap((section) =>
      section.path && !hasDataSource(section.state) ? [section.path] : [],
    ),
  );
}

/** The one empty state of a section this server has no source for. */
export function NoDataSourceState({ section }: { section: DataSection }) {
  return (
    <div className="h-full overflow-auto px-4 py-6 md:px-6">
      <div className="mx-auto max-w-2xl">
        <EmptyState
          icon={Unplug}
          variant="card"
          title={`${section.label} has no data source on this server`}
          description={section.detail}
          action={
            <Button
              nativeButton={false}
              render={<Link to="/help/data-sources" />}
            >
              See data sources
            </Button>
          }
        />
      </div>
    </div>
  );
}
