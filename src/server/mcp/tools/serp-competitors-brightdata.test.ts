import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { SerpObservationRepository } from "@/server/features/serp/repositories/SerpObservationRepository";
import { AppError } from "@/server/lib/errors";
import { ctrAt } from "@/shared/ctr-curve";
import { findSerpCompetitorsTool } from "./dataforseo-research-tools";
import { makeToolContext, textContent } from "./tool-test-support";

// find_serp_competitors on a self-hosted install with Bright Data and no
// DataForSEO: saved first pages come from the real SERP observation store in
// an in-memory SQLite, and live searches from a mocked Bright Data.

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  reserveCalls: vi.fn(),
  getKeywordPlannerClient: vi.fn(),
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
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
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
vi.mock("@/server/lib/googleAdsKeywordPlanner", () => ({
  getKeywordPlannerClient: mocks.getKeywordPlannerClient,
}));

const toolContext = makeToolContext({ organizationId: "organization" });

/** One parsed Google page per keyword, in Bright Data's JSON envelope. */
function answerPages(pages: Record<string, unknown>) {
  mocks.fetch.mockImplementation(async (_url, init) => {
    const { url } = z
      .object({ url: z.string() })
      .parse(JSON.parse(typeof init?.body === "string" ? init.body : ""));
    const keyword = new URL(url).searchParams.get("q") ?? "";
    return Response.json({
      status_code: 200,
      headers: {},
      body: JSON.stringify(pages[keyword] ?? { organic: [] }),
    });
  });
}

const organic = (...links: string[]) => links.map((link) => ({ link }));

function findCompetitors(keywords: string[], extra: object = {}) {
  return findSerpCompetitorsTool.handler(
    { projectId: "project", keywords, ...extra },
    toolContext,
  );
}

beforeEach(async () => {
  vi.stubEnv("DATAFORSEO_API_KEY", "");
  vi.stubEnv("AUTH_MODE", "");
  vi.stubEnv("BRIGHTDATA_API_KEY", "bd-key");
  vi.stubEnv("BRIGHTDATA_SERP_ZONE", "openseo_serp");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project",
    locationCode: 2170,
    languageCode: "es",
  });
  mocks.reserveCalls.mockResolvedValue(7);
  mocks.getKeywordPlannerClient.mockResolvedValue(null);
  await testDb.client.executeMultiple(`
    DELETE FROM serp_observations;
    DELETE FROM rank_tracking_configs;
  `);
  await testDb.seedProject();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("answers from this organization's saved pages and searches only the rest live, near the tracker's city on its device", async () => {
  await testDb.client.executeMultiple(`
    INSERT INTO organization (id, name, slug, created_at)
      VALUES ('other_organization', 'Other', 'other', 0);
    INSERT INTO rank_tracking_configs
      (id, project_id, domain, location_code, language_code, devices, serp_depth, location_name)
      VALUES ('tracker', 'project', 'bandidos.co', 2170, 'es', 'mobile', 10, 'Pereira,Risaralda,Colombia');
  `);
  const page = {
    locationCode: 2170,
    languageCode: "es",
    locationName: "Pereira,Risaralda,Colombia",
    device: "mobile" as const,
    origin: "rank_check" as const,
    features: ["organic"],
  };
  await SerpObservationRepository.record({
    ...page,
    organizationId: "organization",
    keyword: "Hamburguesas Pereira",
    results: [{ section: "organic", position: 1, domain: "bandidos.co" }],
  });
  await SerpObservationRepository.record({
    ...page,
    organizationId: "other_organization",
    keyword: "pizza pereira",
    results: [{ section: "organic", position: 1, domain: "other.co" }],
  });
  answerPages({ "pizza pereira": { organic: organic("https://sumo.co/") } });

  const result = await findCompetitors([
    "hamburguesas pereira",
    "pizza pereira",
  ]);

  const [sent, ...rest] = mocks.fetch.mock.calls.map(([, init]) =>
    typeof init?.body === "string" ? init.body : "",
  );
  expect(rest).toEqual([]);
  expect(sent).toContain("q=pizza+pereira");
  expect(sent).toContain("&uule=w+");
  expect(sent).toContain("&brd_mobile=1");
  expect(result.structuredContent).toMatchObject({
    competitors: [{ domain: "bandidos.co" }, { domain: "sumo.co" }],
    keywords: [
      { keyword: "hamburguesas pereira", source: "saved", device: "mobile" },
      { keyword: "pizza pereira", source: "live", device: "mobile" },
    ],
  });
});

it("searches at most 10 keywords live per call and reports the rest as not checked", async () => {
  answerPages({});
  const keywords = Array.from({ length: 12 }, (_, i) => `k${i + 1}`);

  const result = await findCompetitors(keywords);

  expect(mocks.fetch).toHaveBeenCalledTimes(10);
  expect(textContent(result)).toContain(
    "past this call's 10 live searches: k11, k12",
  );
});

it("counts local pack listings by website, or by name for a profile link, and ranks by CTR-curve visibility", async () => {
  answerPages({
    k1: {
      organic: organic("https://a.com/", "https://b.com/", "https://c.com/"),
      snack_pack: [
        { name: "B Grill", link: "https://www.b.com/" },
        { name: "Sumo", link: "https://www.instagram.com/sumo" },
      ],
    },
    k2: {
      organic: organic("https://b.com/menu"),
      snack_pack: [{ name: "Sumo", link: "https://linktr.ee/sumo" }],
    },
  });

  const result = await findCompetitors(["k1", "k2"], {
    excludeDomains: ["c.com"],
  });

  expect(result.structuredContent).toMatchObject({
    competitors: [
      {
        domain: "b.com",
        name: "B Grill",
        keywords_positions: { k1: 2, k2: 1 },
        local_pack_positions: { k1: 1 },
        visibility: 1,
        etv: null,
      },
      { domain: null, name: "Sumo", local_pack_positions: { k1: 2, k2: 1 } },
      { domain: "a.com", keywords_positions: { k1: 1 }, visibility: 0.5 },
    ],
  });
});

it("estimates etv from Keyword Planner volumes and the CTR curve, lower on a page with an AI Overview", async () => {
  mocks.getKeywordPlannerClient.mockResolvedValue({
    keywords: {
      adsSearchVolume: vi.fn().mockResolvedValue([
        { keyword: "k1", search_volume: 1000 },
        { keyword: "k2", search_volume: 1000 },
      ]),
    },
  });
  answerPages({
    k1: { organic: organic("https://a.com/") },
    k2: {
      organic: organic("https://b.com/"),
      ai_overview: { texts: [{ snippet: "Los mejores..." }] },
    },
  });

  const result = await findCompetitors(["k1", "k2"]);

  const { competitors } = z
    .object({
      competitors: z.array(z.object({ domain: z.string(), etv: z.number() })),
    })
    .parse(result.structuredContent);
  expect(competitors.map((row) => row.domain)).toEqual(["a.com", "b.com"]);
  expect(competitors[0]?.etv).toBeCloseTo(
    1000 * ctrAt(1, { aiOverview: false }),
    1,
  );
  expect(competitors[1]?.etv).toBeCloseTo(
    1000 * ctrAt(1, { aiOverview: true }),
    1,
  );
});

it("leaves etv null while Google has not granted Keyword Planner access", async () => {
  mocks.getKeywordPlannerClient.mockResolvedValue({
    keywords: {
      adsSearchVolume: vi
        .fn()
        .mockRejectedValue(
          new AppError(
            "GOOGLE_ADS_ACCESS_PENDING",
            "Google Ads API access pending.",
          ),
        ),
    },
  });
  answerPages({ k1: { organic: organic("https://a.com/") } });

  const result = await findCompetitors(["k1"]);

  expect(result.structuredContent).toMatchObject({
    competitors: [{ domain: "a.com", visibility: 1, etv: null }],
  });
  expect(textContent(result)).toContain(
    "unavailable here: Google Ads API access pending.",
  );
});
