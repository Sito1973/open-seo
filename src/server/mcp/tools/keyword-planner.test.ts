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
  getProjectById: vi.fn(),
  listCompetitors: vi.fn(),
  getGscConnection: vi.fn(),
  getLatestGrant: vi.fn(),
  upsertKeywordMetric:
    vi.fn<(row: { keyword: string; intent: string | null }) => Promise<void>>(),
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
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectById: mocks.getProjectById },
}));
vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  () => ({
    ProjectContextRepository: { listCompetitors: mocks.listCompetitors },
  }),
);
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: { getByProjectId: mocks.getGscConnection },
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
    KeywordResearchRepository: {
      upsertKeywordMetric: mocks.upsertKeywordMetric,
    },
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

/**
 * Answers each request by the last segment of its URL path: the Google Ads
 * method, Search Console's "query" or the TRM dataset's "32sa-8pi3.json".
 */
function answerGoogleAds(answers: Record<string, () => Response>) {
  mocks.fetch.mockImplementation(async (input) => {
    const path = new URL(urlOf(input)).pathname;
    const answer = answers[path.split(/[:/]/).at(-1) ?? ""];
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
  mocks.getProjectById.mockResolvedValue({ domain: "bandidos.co" });
  mocks.listCompetitors.mockResolvedValue([
    { name: "El Corral", domain: "elcorral.com" },
  ]);
  mocks.getGscConnection.mockResolvedValue(null);
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
        historicalMetricsOptions: { includeAverageCpc: true },
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

it("converts the Planner's CPC from the account's pesos to dollars at the day's TRM", async () => {
  const withCpc = (text: string, micros: object) => ({
    text,
    keywordMetrics: { ...metrics("880", "60"), ...micros },
  });
  answerGoogleAds({
    generateKeywordHistoricalMetrics: () =>
      Response.json({
        results: [
          withCpc("hamburguesas", { averageCpcMicros: "1581880000" }),
          withCpc("picada", {
            lowTopOfPageBidMicros: "1000000000",
            highTopOfPageBidMicros: "2000000000",
          }),
        ],
      }),
    search: () =>
      Response.json({ results: [{ customer: { currencyCode: "COP" } }] }),
    "32sa-8pi3.json": () => Response.json([{ valor: "3163.76" }]),
  });

  const result = await getKeywordMetricsTool.handler(
    { projectId: "project_1", keywords: ["hamburguesas", "picada"] },
    toolContext,
  );

  // 1,581.88 pesos average; 1,500 pesos between the two top-of-page bids.
  expect(result.structuredContent.keywords).toMatchObject([
    { keyword: "hamburguesas", cpc: 0.5 },
    { keyword: "picada", cpc: 0.47 },
  ]);
});

it("stores rule and brand intent from Keyword Planner ideas", async () => {
  const idea = (text: string, type: string) => ({
    text,
    keywordIdeaMetrics: metrics("90", "30"),
    keywordAnnotations: { concepts: [{ conceptGroup: { type } }] },
  });
  answerGoogleAds({
    generateKeywordIdeas: () =>
      Response.json({
        results: [
          idea("frisby", "BRAND"),
          idea("bandidos pereira", "NON_BRAND"),
          idea("pollo a domicilio", "NON_BRAND"),
        ],
      }),
  });

  await researchKeywordsTool.handler(
    { projectId: "project_1", seeds: [{ seed: "pollo" }] },
    toolContext,
  );

  expect(sentRequests()[0].body).toMatchObject({
    keywordAnnotation: ["KEYWORD_CONCEPT"],
  });
  // Google's brand concept, the project's own domain, and a Spanish word rule.
  await vi.waitFor(() =>
    expect(
      mocks.upsertKeywordMetric.mock.calls.map(([row]) => [
        row.keyword,
        row.intent,
      ]),
    ).toEqual([
      ["frisby", "navigational"],
      ["bandidos pereira", "navigational"],
      ["pollo a domicilio", "transactional"],
    ]),
  );
});

it("lists the site's Search Console queries, not volumes, while Basic access is pending", async () => {
  mocks.getGscConnection.mockResolvedValue({
    siteUrl: "sc-domain:bandidos.co",
  });
  answerGoogleAds({
    generateKeywordIdeas: googleAdsFailure(403, {
      authorizationError: "SERVICE_ACCESS_DENIED",
    }),
    query: () =>
      Response.json({
        rows: [
          { keys: ["hamburguesas pereira"], clicks: 9, impressions: 120 },
          { keys: ["hamburguesas a domicilio"], clicks: 2, impressions: 300 },
        ],
      }),
  });

  const result = await researchKeywordsTool.handler(
    { projectId: "project_1", seeds: [{ seed: "hamburguesas" }] },
    toolContext,
  );

  expect(sentRequests()[1].body.dimensionFilterGroups).toMatchObject([
    { filters: [{ operator: "contains", expression: "hamburguesas" }] },
  ]);
  expect(result.structuredContent.results).toMatchObject([
    {
      source: "search_console",
      rows: [
        { keyword: "hamburguesas a domicilio", gscImpressions: 300 },
        { keyword: "hamburguesas pereira", gscImpressions: 120 },
      ].map((row) => ({ ...row, searchVolume: null })),
    },
  ]);
  expect(textContent(result)).toContain("GSC impressions (your site)");
  expect(mocks.upsertKeywordMetric).not.toHaveBeenCalled();
});
