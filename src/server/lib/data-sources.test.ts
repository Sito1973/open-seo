import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDataSources } from "./data-sources";

const usedCalls = vi.hoisted(() =>
  vi.fn<(input: { month: string; sku: string }) => Promise<number>>(),
);

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock(
  "@/server/features/google-places/repositories/GooglePlacesUsageRepository",
  () => ({ GooglePlacesUsageRepository: { usedCalls } }),
);
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: async () => "key",
  getCached: async () => null,
  setCached: async () => undefined,
}));

const MONTH_USE: Record<string, number> = {
  brightdata_serp: 120,
  dataforseo_backlinks: 7,
};

beforeEach(() => {
  // Empty values fall through to the (empty) Workers env, so only the keys
  // a test sets count.
  for (const name of [
    "GOOGLE_PLACES_API_KEY",
    "GOOGLE_ADS_CUSTOMER_ID",
    "SERPAPI_API_KEY",
    "GOOGLE_CLIENT_ID",
    "DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS",
  ]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("AUTH_MODE", "local_noauth");
  vi.stubEnv("DATAFORSEO_API_KEY", "dataforseo-key");
  vi.stubEnv("DATAFORSEO_SCOPE", "backlinks");
  vi.stubEnv("BRIGHTDATA_API_KEY", "brightdata-key");
  vi.stubEnv("BRIGHTDATA_SERP_ZONE", "serp_zone");
  usedCalls.mockImplementation(async ({ sku }) => MONTH_USE[sku] ?? 0);
});
afterEach(() => vi.unstubAllEnvs());

it("says what serves each section and reads this month's budgets", async () => {
  const status = await getDataSources();

  const states = Object.fromEntries(
    (status?.sections ?? []).map((section) => [section.id, section.state]),
  );
  expect(states).toMatchObject({
    rank_tracking: "ready",
    backlinks: "ready",
    keyword_research: "needs_setup",
    domain: "needs_setup",
    prompt_explorer: "unavailable",
  });
  expect(status?.budgets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        label: "Bright Data SERP requests",
        used: 120,
        limit: 4500,
      }),
      expect.objectContaining({
        label: "DataForSEO backlinks requests",
        used: 7,
        limit: 300,
      }),
    ]),
  );
  expect(status?.budgets.map((budget) => budget.label)).not.toContain(
    "SerpApi searches (Google AI Mode)",
  );
});

it.each([
  { case: "hosted", AUTH_MODE: "hosted", DATAFORSEO_SCOPE: "backlinks" },
  { case: "DataForSEO for everything", AUTH_MODE: "", DATAFORSEO_SCOPE: "" },
])("has no map where DataForSEO serves every section ($case)", async (env) => {
  vi.stubEnv("AUTH_MODE", env.AUTH_MODE);
  vi.stubEnv("DATAFORSEO_SCOPE", env.DATAFORSEO_SCOPE);

  expect(await getDataSources()).toBeNull();
});
