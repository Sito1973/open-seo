import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { KeywordResearchService } from "@/server/features/keywords/services/KeywordResearchService";
import { SerpObservationRepository } from "@/server/features/serp/repositories/SerpObservationRepository";
import { estimateKeywordDifficultyTool } from "./estimate-keyword-difficulty";
import { listSavedKeywordsTool } from "./list-saved-keywords";
import { makeToolContext, textContent } from "./tool-test-support";

// estimate_keyword_difficulty on a self-hosted install with Bright Data and no
// DataForSEO: saved first pages and estimates live in an in-memory SQLite;
// Bright Data and Open PageRank answer from a mocked fetch.

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  reserveCalls: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));
const testDb = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return createAiVisibilityTestDb();
});

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: (promise: Promise<unknown>) => promise,
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
  DB_BATCH_SIZE: 100,
}));
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: async (prefix: string) => prefix,
  getCached: async () => null,
  setCached: async () => undefined,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/google-places/repositories/GooglePlacesUsageRepository",
  () => ({
    GooglePlacesUsageRepository: { reserveCalls: mocks.reserveCalls },
  }),
);

const toolContext = makeToolContext({ organizationId: "organization" });

const organic = (...links: string[]) => links.map((link) => ({ link }));

const urlOf = (input: string | URL | Request) =>
  input instanceof Request ? input.url : input.toString();

/**
 * Bright Data answers one parsed Google page per keyword; Open PageRank
 * answers these scores, null for a domain it does not know.
 */
function answer(input: {
  pages?: Record<string, unknown>;
  openPageRank?: Record<string, number>;
}) {
  mocks.fetch.mockImplementation(async (url, init) => {
    const body: unknown = JSON.parse(
      typeof init?.body === "string" ? init.body : "",
    );
    if (urlOf(url).includes("openpagerank")) {
      const { domains } = z
        .object({ domains: z.array(z.string()) })
        .parse(body);
      return Response.json({
        results: domains.map((domain) => ({
          domain,
          open_page_rank: input.openPageRank?.[domain] ?? null,
        })),
      });
    }
    const keyword =
      new URL(z.object({ url: z.string() }).parse(body).url).searchParams.get(
        "q",
      ) ?? "";
    return Response.json({
      status_code: 200,
      headers: {},
      body: JSON.stringify(input.pages?.[keyword] ?? { organic: [] }),
    });
  });
}

const requestsTo = (host: string) =>
  mocks.fetch.mock.calls.filter(([url]) => urlOf(url).includes(host));

function estimate(keywords: string[]) {
  return estimateKeywordDifficultyTool.handler(
    { projectId: "project", keywords },
    toolContext,
  );
}

/** A first page of "hamburguesas pereira" saved today: no request needed. */
function saveBurgerPage() {
  return SerpObservationRepository.record({
    organizationId: "organization",
    keyword: "hamburguesas pereira",
    locationCode: 2170,
    languageCode: "es",
    device: "mobile",
    origin: "rank_check",
    features: ["organic", "local_pack"],
    results: [
      { section: "organic", position: 1, domain: "bandidos.co" },
      { section: "organic", position: 2, domain: "facebook.com" },
      ...[50, 500, 3000].map((reviewsCount, index) => ({
        section: "local_pack" as const,
        position: index + 1,
        reviewsCount,
      })),
    ],
  });
}

beforeEach(async () => {
  vi.stubEnv("DATAFORSEO_API_KEY", "");
  vi.stubEnv("AUTH_MODE", "");
  vi.stubEnv("BRIGHTDATA_API_KEY", "bd-key");
  vi.stubEnv("BRIGHTDATA_SERP_ZONE", "openseo_serp");
  vi.stubEnv("OPENPAGERANK_API_KEY", "opr-key");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project",
    locationCode: 2170,
    languageCode: "es",
  });
  mocks.reserveCalls.mockResolvedValue(7);
  await testDb.client.executeMultiple(`
    DELETE FROM serp_observations;
    DELETE FROM keyword_difficulty_estimates;
    DELETE FROM saved_keywords;
    DELETE FROM keyword_metrics;
  `);
  await testDb.seedProject();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("estimates from a saved page at no cost and searches only the rest live, from the local pack and Open PageRank", async () => {
  await saveBurgerPage();
  answer({
    pages: { "pizza pereira": { organic: organic("https://sumo.co/") } },
    openPageRank: { "bandidos.co": 3, "facebook.com": 9, "sumo.co": 2.5 },
  });

  const result = await estimate(["hamburguesas pereira", "pizza pereira"]);

  expect(requestsTo("brightdata")).toHaveLength(1);
  expect(result.structuredContent).toMatchObject({
    keywords: [
      {
        keyword: "hamburguesas pereira",
        // local: 500 median reviews -> 58. organic: Open PageRank x10
        // weighted by CTR (30 at #1, 90 at #2) is 52, minus 10 for Facebook
        // in the top 5 -> 42. KD: 0.6 x 58 + 0.4 x 42.
        local_score: 58,
        organic_score: 42,
        keyword_difficulty: 52,
      },
      {
        keyword: "pizza pereira",
        local_score: null,
        organic_score: 25,
        keyword_difficulty: 25,
        page: "searched now",
      },
    ],
  });
});

it("without OPENPAGERANK_API_KEY, estimates from the local pack alone and leaves a page without one unestimated", async () => {
  vi.stubEnv("OPENPAGERANK_API_KEY", "");
  await saveBurgerPage();
  answer({
    pages: { "pizza pereira": { organic: organic("https://sumo.co/") } },
  });

  const result = await estimate(["hamburguesas pereira", "pizza pereira"]);

  expect(requestsTo("openpagerank")).toEqual([]);
  expect(result.structuredContent).toMatchObject({
    keywords: [
      { keyword: "hamburguesas pereira", keyword_difficulty: 58 },
      { keyword: "pizza pereira", keyword_difficulty: null },
    ],
  });
  expect(textContent(result)).toContain(
    "organic not measured: OPENPAGERANK_API_KEY is not set on this server.",
  );
});

it("sends no live search once the monthly estimate budget is used up", async () => {
  mocks.reserveCalls.mockImplementation(async ({ sku }: { sku: string }) =>
    sku === "difficulty_estimate" ? null : 7,
  );
  answer({});

  const result = await estimate(["pizza pereira"]);

  expect(requestsTo("brightdata")).toEqual([]);
  expect(textContent(result)).toContain(
    "monthly budget for difficulty estimates (300 live Google searches",
  );
});

it("shows saved keywords' estimates labeled next to provider difficulty, which wins, and filters on what it shows", async () => {
  await testDb.client.executeMultiple(`
    INSERT INTO saved_keywords (id, project_id, keyword, location_code, language_code)
      VALUES ('burger', 'project', 'hamburguesas pereira', 2170, 'es'),
             ('pizza', 'project', 'pizza pereira', 2170, 'es');
    INSERT INTO keyword_metrics (project_id, keyword, location_code, language_code, keyword_difficulty)
      VALUES ('project', 'pizza pereira', 2170, 'es', 40);
    INSERT INTO keyword_difficulty_estimates
      (project_id, keyword, location_code, language_code, keyword_difficulty, observed_at, computed_at)
      VALUES ('project', 'hamburguesas pereira', 2170, 'es', 58, '2026-10-20', '2026-10-20'),
             ('project', 'pizza pereira', 2170, 'es', 30, '2026-10-20', '2026-10-20');
  `);

  const listed = await listSavedKeywordsTool.handler(
    { projectId: "project" },
    toolContext,
  );
  const hard = await KeywordResearchService.getSavedKeywords({
    projectId: "project",
    minDifficulty: 50,
    page: 1,
    pageSize: 50,
    sort: "keywordDifficulty",
    order: "desc",
  });

  expect(textContent(listed)).toContain("hamburguesas pereira  id:burger");
  expect(textContent(listed)).toContain("kd:~58");
  expect(textContent(listed)).toContain("kd:40");
  expect(textContent(listed)).toContain('KD "~N" is an OpenSEO estimate');
  expect(hard.rows.map((row) => row.keyword)).toEqual(["hamburguesas pereira"]);
});
