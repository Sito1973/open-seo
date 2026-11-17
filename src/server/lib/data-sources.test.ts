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
  // treg's counter is in millionths of a US dollar.
  treg_usd_micro: 12_340,
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
    "TREG_MONTHLY_BUDGET_USD",
  ]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("AUTH_MODE", "local_noauth");
  vi.stubEnv("DATAFORSEO_API_KEY", "dataforseo-key");
  vi.stubEnv("DATAFORSEO_SCOPE", "backlinks");
  vi.stubEnv("BRIGHTDATA_API_KEY", "brightdata-key");
  vi.stubEnv("BRIGHTDATA_SERP_ZONE", "serp_zone");
  vi.stubEnv("TREG_API_KEY", "treg-key");
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
    social_and_ads: "ready",
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
      // The one budget in US dollars, $2 a month unless set.
      expect.objectContaining({
        label: "treg spend",
        used: 0.01234,
        limit: 2,
        unit: "usd",
      }),
    ]),
  );
  expect(status?.budgets.map((budget) => budget.label)).not.toContain(
    "SerpApi searches (Google AI Mode)",
  );
});

it("lists treg as needing setup, with no budget, until its key is set", async () => {
  vi.stubEnv("TREG_API_KEY", "");

  const status = await getDataSources();

  const section = status?.sections.find(
    (candidate) => candidate.id === "social_and_ads",
  );
  expect(section?.state).toBe("needs_setup");
  expect(section?.detail).toContain("TREG_API_KEY");
  expect(status?.budgets.map((budget) => budget.label)).not.toContain(
    "treg spend",
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
