import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { getKeywordMetricsTool } from "./dataforseo-research-tools";
import { researchKeywordsTool } from "./research-keywords";
import { makeToolContext, textContent } from "./tool-test-support";

// The Google Ads Keyword Planner path of keyword research: a self-hosted
// install with the GOOGLE_ADS_* variables, a connected Google Ads grant and no
// DataForSEO key.

const mocks = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  getProjectForOrganization: vi.fn(),
  getLatestGrant: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    R2: {
      get: async (key: string) => {
        const value = mocks.cache.get(key);
        return value === undefined ? null : { text: async () => value };
      },
      put: async (key: string, value: string) => mocks.cache.set(key, value),
    },
  },
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/google-ads/GoogleAdsGrantRepository", () => ({
  GoogleAdsGrantRepository: { getLatestGrant: mocks.getLatestGrant },
}));
vi.mock("@/server/features/google/googleOAuth", () => ({
  getGoogleAccessToken: async () => "ads-access-token",
}));
vi.mock(
  "@/server/features/keywords/repositories/KeywordResearchRepository",
  () => ({
    KeywordResearchRepository: { upsertKeywordMetric: async () => {} },
  }),
);

const toolContext = makeToolContext();

const requestSchema = z.looseObject({
  geoTargetConstants: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  query: z.string().optional(),
});

function urlOf(input: Parameters<typeof fetch>[0]) {
  return input instanceof Request ? input.url : input.toString();
}

/** Answers each Google Ads method (the URL's last segment) from `answers`. */
function answerGoogleAds(answers: Record<string, () => Response>) {
  mocks.fetch.mockImplementation(async (input) => {
    const answer = answers[urlOf(input).split(/[:/]/).at(-1) ?? ""];
    return answer ? answer() : new Response(null, { status: 404 });
  });
}

function sentRequests() {
  return mocks.fetch.mock.calls.map(([input, init]) => {
    const headers = new Headers(init?.headers);
    return {
      url: urlOf(input),
      authorization: headers.get("Authorization"),
      loginCustomerId: headers.get("login-customer-id"),
      developerToken: headers.get("developer-token"),
      body: requestSchema.parse(
        JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
      ),
    };
  });
}

const metrics = (avgMonthlySearches: string, competitionIndex: string) => ({
  avgMonthlySearches,
  competition: "MEDIUM",
  competitionIndex,
  monthlySearchVolumes: [
    { year: "2026", month: "SEPTEMBER", monthlySearches: avgMonthlySearches },
  ],
});

/** A Google Ads API error response carrying one GoogleAdsFailure error. */
function googleAdsFailure(status: number, errorCode: Record<string, string>) {
  return () =>
    Response.json(
      { error: { details: [{ errors: [{ errorCode }] }] } },
      { status },
    );
}

beforeEach(() => {
  mocks.cache.clear();
  vi.stubEnv("DATAFORSEO_API_KEY", "");
  vi.stubEnv("AUTH_MODE", "");
  vi.stubEnv("GOOGLE_ADS_CLIENT_ID", "ads-client-id");
  vi.stubEnv("GOOGLE_ADS_CLIENT_SECRET", "ads-client-secret");
  vi.stubEnv("GOOGLE_ADS_CUSTOMER_ID", "927-025-0391");
  vi.stubEnv("GOOGLE_ADS_LOGIN_CUSTOMER_ID", "6590174882");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    locationCode: 2170,
    languageCode: "es",
  });
  mocks.getLatestGrant.mockResolvedValue({ accountId: "google-account-1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("reads keyword volumes from Keyword Planner and shares a close variant's numbers", async () => {
  answerGoogleAds({
    generateKeywordHistoricalMetrics: () =>
      Response.json({
        results: [
          {
            text: "hamburguesa",
            closeVariants: ["hamburguesas"],
            keywordMetrics: metrics("12100", "54"),
          },
        ],
      }),
  });

  const result = await getKeywordMetricsTool.handler(
    { projectId: "project_1", keywords: ["hamburguesa", "hamburguesas"] },
    toolContext,
  );

  expect(sentRequests()).toEqual([
    {
      url: "https://googleads.googleapis.com/v26/customers/9270250391:generateKeywordHistoricalMetrics",
      authorization: "Bearer ads-access-token",
      loginCustomerId: "6590174882",
      developerToken: null,
      body: {
        keywords: ["hamburguesa", "hamburguesas"],
        geoTargetConstants: ["geoTargetConstants/2170"],
        language: "languageConstants/1003",
        keywordPlanNetwork: "GOOGLE_SEARCH",
        includeAdultKeywords: false,
      },
    },
  ]);
  const row = {
    search_volume: 12100,
    keyword_difficulty: null,
    main_intent: null,
    cpc: null,
    competition: 0.54,
    competition_level: "MEDIUM",
    monthly_searches: [{ year: 2026, month: 9, search_volume: 12100 }],
  };
  expect(result.structuredContent.keywords).toEqual([
    { keyword: "hamburguesa", ...row },
    { keyword: "hamburguesas", ...row },
  ]);
  expect(textContent(result)).toContain("Source: Google Ads Keyword Planner");
});

it("answers a repeat in the same month from the cache", async () => {
  answerGoogleAds({
    generateKeywordHistoricalMetrics: () =>
      Response.json({
        results: [{ text: "pizza", keywordMetrics: metrics("900", "20") }],
      }),
  });
  const args = { projectId: "project_1", keywords: ["pizza"] };

  await getKeywordMetricsTool.handler(args, toolContext);
  const repeat = await getKeywordMetricsTool.handler(args, toolContext);

  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(repeat.structuredContent.keywords).toMatchObject([
    { keyword: "pizza", search_volume: 900 },
  ]);
});

it("gives city volumes for national ideas through the city's geo target", async () => {
  answerGoogleAds({
    generateKeywordIdeas: () =>
      Response.json({
        results: [
          { text: "hamburguesas", keywordIdeaMetrics: metrics("12100", "54") },
          {
            text: "hamburguesas pereira",
            keywordIdeaMetrics: metrics("90", "80"),
          },
        ],
      }),
    search: () =>
      Response.json({
        results: [{ geoTargetConstant: { id: "1003665", countryCode: "CO" } }],
      }),
    generateKeywordHistoricalMetrics: () =>
      Response.json({
        results: [
          { text: "hamburguesas", keywordMetrics: metrics("880", "60") },
          { text: "hamburguesas pereira", keywordMetrics: metrics("70", "80") },
        ],
      }),
  });

  const result = await researchKeywordsTool.handler(
    {
      projectId: "project_1",
      seeds: [
        { seed: "hamburguesas", locationName: "Pereira,Risaralda,Colombia" },
      ],
    },
    toolContext,
  );

  const requests = sentRequests();
  expect(requests.map((request) => request.body)).toMatchObject([
    { geoTargetConstants: ["geoTargetConstants/2170"] },
    {},
    {
      keywords: ["hamburguesas", "hamburguesas pereira"],
      geoTargetConstants: ["geoTargetConstants/1003665"],
    },
  ]);
  expect(requests[1].url).toBe(
    "https://googleads.googleapis.com/v26/customers/9270250391/googleAds:search",
  );
  expect(requests[1].body.query).toContain(
    'geo_target_constant.canonical_name = "Pereira,Risaralda,Colombia"',
  );
  expect(result.structuredContent.results).toMatchObject([
    {
      ok: true,
      source: "google_ads",
      rows: [
        { keyword: "hamburguesas", searchVolume: 880, keywordDifficulty: null },
        { keyword: "hamburguesas pereira", searchVolume: 70 },
      ],
    },
  ]);
});

it("reports Explorer access as pending instead of a generic error", async () => {
  answerGoogleAds({
    generateKeywordHistoricalMetrics: googleAdsFailure(403, {
      authorizationError: "SERVICE_ACCESS_DENIED",
    }),
  });

  const failure = getKeywordMetricsTool.handler(
    { projectId: "project_1", keywords: ["pizza"] },
    toolContext,
  );

  await expect(failure).rejects.toMatchObject({
    code: "GOOGLE_ADS_ACCESS_PENDING",
  });
  await expect(failure).rejects.toThrow(
    "Google Ads API access pending (Explorer level blocks Keyword Planner)",
  );
});

it("reports an unknown customer ID as configuration, not a lost connection", async () => {
  answerGoogleAds({
    generateKeywordHistoricalMetrics: googleAdsFailure(401, {
      authenticationError: "CUSTOMER_NOT_FOUND",
    }),
  });

  const failure = getKeywordMetricsTool.handler(
    { projectId: "project_1", keywords: ["pizza"] },
    toolContext,
  );

  await expect(failure).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(failure).rejects.toThrow("customer 9270250391");
});

it("leaves out the search_serp_locations hint, which needs DataForSEO, for an unknown city", async () => {
  answerGoogleAds({
    generateKeywordIdeas: () =>
      Response.json({
        results: [{ text: "pizza", keywordIdeaMetrics: metrics("900", "20") }],
      }),
    search: () => Response.json({}),
  });

  const result = await researchKeywordsTool.handler(
    {
      projectId: "project_1",
      seeds: [{ seed: "pizza", locationName: "Atlantis,Risaralda,Colombia" }],
    },
    toolContext,
  );

  const [seed] = result.structuredContent.results;
  expect(seed).toMatchObject({ ok: false });
  expect(seed.ok ? "" : seed.error).toContain("is not a Google Ads location");
  expect(textContent(result)).not.toContain("search_serp_locations");
});
