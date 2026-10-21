import { createFileRoute } from "@tanstack/react-router";
import { DataSourcesPage } from "@/client/features/help/DataSourcesPage";

export const Route = createFileRoute("/_app/help/data-sources")({
  component: DataSourcesPage,
});
