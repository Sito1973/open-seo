import { createServerFn } from "@tanstack/react-start";
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
