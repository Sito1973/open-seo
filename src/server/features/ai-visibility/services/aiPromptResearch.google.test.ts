import { beforeEach, expect, it, vi } from "vitest";
import { GscNotConnectedError } from "@/server/lib/gscErrors";

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));

const {
  createDataforseoClient,
  fetchBrightDataSerp,
  getBrightDataSerp,
  fetchGoogleAutocomplete,
  getPerformance,
  getSearchKeywords,
  getLatestAnswer,
  getEvidence,
  getTracker,
} = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  fetchBrightDataSerp: vi.fn(),
  getBrightDataSerp: vi.fn(),
  fetchGoogleAutocomplete: vi.fn(),
  getPerformance: vi.fn(),
  getSearchKeywords: vi.fn(),
  getLatestAnswer: vi.fn(),
  getEvidence: vi.fn(),
  getTracker: vi.fn(),
}));

// Self-hosted, without DataForSEO for other features.
vi.mock("@/server/lib/runtime-env", () => ({
  getDataforseoKey: async () => null,
  isHostedServerAuthMode: async () => false,
}));
vi.mock("@/server/lib/dataforseo", () => ({ createDataforseoClient }));
vi.mock("@/server/features/ai-search/services/access", () => ({
  assertPaidAiSearchPlan: async () => undefined,
}));
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: async () => "key",
  getCached: async () => null,
  setCached: async () => undefined,
}));
vi.mock("@/server/lib/brightDataSerp", () => ({
  fetchBrightDataSerp,
  getBrightDataSerp,
}));
vi.mock("@/server/lib/googleAutocomplete", () => ({ fetchGoogleAutocomplete }));
vi.mock("@/server/lib/googleAdsKeywordPlanner", () => ({
  getKeywordPlannerClient: async () => null,
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance },
}));
vi.mock("@/server/features/gbp/services/GbpService", () => ({
  GbpService: { getSearchKeywords },
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectForOrganization: async () => ({
      id: "project",
      domain: "bandidos.co",
      locationCode: 2170,
      languageCode: "es",
    }),
  },
}));
vi.mock("@/server/features/serp/services/googleCandidates", () => ({
  projectSearchTracker: async () => ({
    market: {
      locationCode: 2170,
      languageCode: "es",
      locationName: "Pereira,Risaralda,Colombia",
    },
    device: "mobile",
  }),
}));
vi.mock("../repositories/AiVisibilityRepository", () => ({
  AiVisibilityRepository: { getLatestAnswer, getEvidence },
}));
vi.mock("./aiVisibilityState", () => ({ getTracker }));

import { researchAiPrompts } from "./aiPromptResearch";
import { customer } from "./aiVisibilityTestFixtures";

const input = { projectId: "project", keyword: "Hamburguesas" };

beforeEach(() => {
  getTracker.mockResolvedValue({
    tracker: { locationCode: 2170, languageCode: "es" },
    brands: [{ own: true, name: "Bandidos", domain: "bandidos.co" }],
    prompts: [
      {
        id: "p1",
        text: "¿Dónde comer hamburguesas en Pereira?",
        topic: "Hamburguesas",
        archived: false,
      },
    ],
  });
  getBrightDataSerp.mockResolvedValue({ apiKey: "key", zone: "serp" });
  fetchBrightDataSerp.mockResolvedValue({
    peopleAlsoAsk: [
      {
        question: "¿Cuál es la mejor hamburguesa de Pereira?",
        answer: "Bandidos es la favorita.",
        url: "https://www.bandidos.co/menu",
        domain: "bandidos.co",
      },
    ],
    relatedSearches: ["hamburguesas a domicilio pereira"],
  });
  fetchGoogleAutocomplete.mockResolvedValue({
    suggestions: ["donde comer hamburguesas en pereira", "que pizza pedir"],
    unavailable: null,
  });
  getPerformance.mockResolvedValue({
    rows: [
      { keys: ["cuanto cuesta una hamburguesa en bandidos"], impressions: 40 },
    ],
  });
  getSearchKeywords.mockResolvedValue({
    keywords: [
      {
        keyword: "hamburguesas a domicilio pereira",
        impressions: 120,
        impressionsBelow: null,
      },
      { keyword: "pizza pereira", impressions: 500, impressionsBelow: null },
    ],
  });
  getLatestAnswer.mockResolvedValue({
    id: "o1",
    engine: "google_ai_overview",
    collectedAt: "2026-10-01T00:00:00.000Z",
    answerMarkdown: "Bandidos y El Corral.",
  });
  getEvidence.mockResolvedValue({
    sources: [
      {
        observationId: "o1",
        domain: "elcorral.com",
        url: "https://elcorral.com",
        title: null,
      },
    ],
    matches: [
      { observationId: "o1", own: true, mentioned: true, cited: false },
    ],
  });
});

it("ranks Google's candidates by labeled volume, merges duplicates and shows a tracked prompt's last answer, without DataForSEO", async () => {
  const result = await researchAiPrompts(input, customer);

  expect(createDataforseoClient).not.toHaveBeenCalled();
  // Five autocomplete lookups: question forms and the tracked city.
  expect(fetchGoogleAutocomplete).toHaveBeenCalledWith(
    expect.objectContaining({
      queries: [
        "donde comer hamburguesas",
        "cual es el mejor hamburguesas",
        "que hamburguesas",
        "recomienden hamburguesas",
        "hamburguesas en pereira",
      ],
    }),
  );
  // Business Profile impressions, then Search Console, then no volume. Pizza
  // is not about the keyword.
  expect(result.prompts).toMatchObject([
    {
      text: "Hamburguesas a domicilio pereira",
      origins: ["related_search", "business_profile"],
      volume: { source: "business_profile", value: 120 },
    },
    {
      text: "Cuanto cuesta una hamburguesa en bandidos",
      volume: { source: "search_console", value: 40 },
    },
    {
      text: "¿Dónde comer hamburguesas en Pereira?",
      tracked: true,
      origins: ["tracked", "autocomplete"],
      volume: null,
      answer: { kind: "last_answer", text: "Bandidos y El Corral." },
      brandMentioned: true,
      ownDomainCited: false,
    },
    {
      text: "¿Cuál es la mejor hamburguesa de Pereira?",
      tracked: false,
      answer: { kind: "people_also_ask", text: "Bandidos es la favorita." },
      brandMentioned: true,
      ownDomainCited: true,
    },
  ]);
  expect(result.prompts).toHaveLength(4);
  expect(result.withoutModel?.notes).toEqual([]);
});

it("lists what the other sources found, with a note, when a source is not set up", async () => {
  getBrightDataSerp.mockResolvedValue(null);
  getPerformance.mockRejectedValue(new GscNotConnectedError("project"));

  const result = await researchAiPrompts(input, customer);

  expect(fetchBrightDataSerp).not.toHaveBeenCalled();
  expect(result.prompts.map((prompt) => prompt.text)).toEqual([
    "Hamburguesas a domicilio pereira",
    "¿Dónde comer hamburguesas en Pereira?",
  ]);
  expect(result.withoutModel?.notes).toEqual([
    expect.stringContaining("BRIGHTDATA_API_KEY"),
    expect.stringContaining("Search Console is not connected"),
  ]);
});
