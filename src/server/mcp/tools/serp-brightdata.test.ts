import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { findSerpCompetitorsTool } from "./dataforseo-research-tools";
import { getSerpResultsTool } from "./get-serp-results";
import { makeToolContext, textContent } from "./tool-test-support";

// The Bright Data path of the live SERP tools: a self-hosted install with
// BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE and no DataForSEO key.

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  getProjectForOrganization: vi.fn(),
  reserveCalls: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: async () => "key",
  getCached: mocks.getCached,
  setCached: mocks.setCached,
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
  SERP_ANALYSIS_DEPTH: 20,
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

const toolContext = makeToolContext();

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
      body: JSON.stringify(pages[keyword]),
    });
  });
}

const organic = (...links: string[]) => links.map((link) => ({ link }));

beforeEach(() => {
  vi.stubEnv("DATAFORSEO_API_KEY", "");
  vi.stubEnv("AUTH_MODE", "");
  vi.stubEnv("BRIGHTDATA_API_KEY", "bd-key");
  vi.stubEnv("BRIGHTDATA_SERP_ZONE", "openseo_serp");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    locationCode: 2170,
    languageCode: "es",
  });
  mocks.reserveCalls.mockResolvedValue(7);
  mocks.getCached.mockResolvedValue(null);
  mocks.setCached.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("reads one live page per query with its local pack and source", async () => {
  answerPages({
    "hamburguesas pereira": {
      organic: [
        {
          link: "https://www.example.com/",
          title: "Example",
          description: "d",
        },
      ],
      snack_pack: [
        {
          name: "Burger Place",
          link: "https://burger.co/",
          rating: 4.6,
          reviews_cnt: 120,
        },
      ],
    },
  });

  const result = await getSerpResultsTool.handler(
    { projectId: "project_1", queries: [{ keyword: "hamburguesas pereira" }] },
    toolContext,
  );

  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
  expect(result.structuredContent).toMatchObject({
    provider: "brightdata",
    results: [
      {
        ok: true,
        items: [
          {
            type: "organic",
            rank: 1,
            domain: "example.com",
            url: "https://www.example.com/",
          },
          {
            type: "local_pack",
            rank: 1,
            title: "Burger Place",
            rating: 4.6,
            reviews_count: 120,
          },
        ],
      },
    ],
  });
  const text = textContent(result);
  expect(text).toContain("Bright Data live Google SERP from www.google.com.co");
  expect(text).toContain("7 of 4500 SERP requests used this month");
});

it("returns the page's other sections as typed rows ranked within each section", async () => {
  answerPages({
    cafe: {
      organic: organic("https://a.com/"),
      featured_snippets: [
        {
          title: "Top cafés",
          link: "https://www.guia.co/top",
          items: [{ text: "Café A" }, { text: "Café B" }],
        },
      ],
      people_also_ask: [
        {
          question: "¿Dónde tomar café?",
          answer: "En el centro",
          link: "https://blog.co/x",
        },
      ],
      ai_overview: {
        texts: [{ snippet: "Hay muchos cafés." }, { list: [{ snippet: "A" }] }],
        references: [{ href: "https://www.tripadvisor.co/x", title: "TA" }],
      },
      knowledge: { title: "Café A", subtitle: "Cafetería" },
      top_ads: [{ title: "Pide ya", link: "https://rappi.com.co/" }],
      bottom_ads: [{ title: "Domicilio", link: "https://ifood.co/" }],
      related: [
        { text: "cafe cerca", items: [{ text: "cafe 24 horas" }] },
        { text: "cafe 24 horas" },
      ],
    },
  });

  const result = await getSerpResultsTool.handler(
    { projectId: "project_1", queries: [{ keyword: "cafe" }] },
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({
    results: [
      {
        ai_overview: "detected",
        items: [
          { type: "organic", rank: 1, domain: "a.com" },
          {
            type: "featured_snippet",
            rank: 1,
            domain: "guia.co",
            description: "Café A; Café B",
          },
          {
            type: "people_also_ask",
            rank: 1,
            title: "¿Dónde tomar café?",
            description: "En el centro",
            domain: "blog.co",
          },
          {
            type: "ai_overview",
            rank: 1,
            description: "Hay muchos cafés.\nA",
          },
          { type: "ai_overview_reference", rank: 1, domain: "tripadvisor.co" },
          {
            type: "knowledge_graph",
            rank: 1,
            title: "Café A",
            description: "Cafetería",
          },
          { type: "paid", rank: 1, placement: "top", domain: "rappi.com.co" },
          { type: "paid", rank: 2, placement: "bottom", domain: "ifood.co" },
          { type: "related_searches", rank: 1, title: "cafe cerca" },
          { type: "related_searches", rank: 2, title: "cafe 24 horas" },
        ],
      },
    ],
  });
});

it("drops a section Bright Data reshapes and reports the AI Overview as not detected", async () => {
  answerPages({
    cafe: {
      organic: organic("https://a.com/"),
      people_also_ask: "unexpected",
      ai_overview: ["unexpected"],
    },
  });

  const result = await getSerpResultsTool.handler(
    { projectId: "project_1", queries: [{ keyword: "cafe" }] },
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({
    results: [
      {
        ok: true,
        ai_overview: "not_detected",
        items: [{ type: "organic", domain: "a.com" }],
      },
    ],
  });
  expect(textContent(result)).toContain("AI Overview: not detected.");
});

it("answers a repeat within 12 hours from the cache without a request", async () => {
  answerPages({ cafe: { organic: organic("https://a.com/") } });
  const args = { projectId: "project_1", queries: [{ keyword: "cafe" }] };

  await getSerpResultsTool.handler(args, toolContext);
  mocks.getCached.mockResolvedValue(mocks.setCached.mock.calls[0]?.[1]);
  const repeat = await getSerpResultsTool.handler(args, toolContext);

  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(repeat.structuredContent).toMatchObject({
    results: [{ ok: true, items: [{ rank: 1, domain: "a.com" }] }],
  });
});

it("sends a query's city as Google's uule without a DataForSEO lookup", async () => {
  answerPages({ cafe: { organic: organic("https://a.com/") } });

  const result = await getSerpResultsTool.handler(
    {
      projectId: "project_1",
      queries: [
        { keyword: "cafe", locationName: "Pereira,Risaralda,Colombia" },
      ],
    },
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({ results: [{ ok: true }] });
  expect(mocks.fetch.mock.calls[0]?.[1]?.body).toContain("&uule=w+");
});

it.each([
  ["DATAFORSEO_API_KEY is set", "DATAFORSEO_API_KEY", "dataforseo-key"],
  ["the server is hosted", "AUTH_MODE", "hosted"],
])("keeps DataForSEO when %s", async (_case, name, value) => {
  vi.stubEnv(name, value);
  const live = vi.fn().mockResolvedValue([]);
  mocks.createDataforseoClient.mockReturnValue({ serp: { live } });

  await getSerpResultsTool.handler(
    { projectId: "project_1", queries: [{ keyword: "cafe" }] },
    toolContext,
  );

  expect(live).toHaveBeenCalledTimes(1);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("ranks competitors by keyword count and average best position across live top 10s", async () => {
  answerPages({
    k1: {
      organic: organic("https://a.com/1", "https://b.com/1", "https://a.com/2"),
    },
    k2: {
      organic: organic("https://b.com/x", "https://c.com/", "https://a.com/y"),
    },
  });

  const result = await findSerpCompetitorsTool.handler(
    {
      projectId: "project_1",
      keywords: ["k1", "k2"],
      excludeDomains: ["c.com"],
    },
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({
    provider: "brightdata",
    competitors: [
      {
        domain: "b.com",
        keywords_count: 2,
        avg_position: 1.5,
        median_position: 1.5,
        keywords_positions: { k1: 2, k2: 1 },
      },
      {
        domain: "a.com",
        keywords_count: 2,
        avg_position: 2,
        median_position: 2,
        keywords_positions: { k1: 1, k2: 3 },
      },
    ],
  });
});
