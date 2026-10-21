import { createServerFn } from "@tanstack/react-start";
import { getDataSources } from "@/server/lib/data-sources";
import { getSeoDataProviders } from "@/server/lib/setup-status";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";

// The shell asks for setup only when nothing serves SEO data: neither
// DataForSEO (for every feature or for backlinks only) nor a stand-in.
export const getSeoApiKeyStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async () => {
    const { dataforseo, standIns } = await getSeoDataProviders();
    return { configured: dataforseo !== null || standIns.length > 0 };
  });

// What serves each section on a self-hosted server without DataForSEO, with
// its monthly budgets: the /help/data-sources page, the sidebar and the
// shared "no source" empty state. Null on hosted and wherever DataForSEO
// serves every feature.
export const getDataSourcesStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(() => getDataSources());
