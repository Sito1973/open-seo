import { beforeEach, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { research } from "./research";

// Keyword research's phrase match and related modes on a self-hosted install
// where the Keyword Planner stands in for DataForSEO.

const mocks = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  adsIdeas: vi.fn(),
  adsSearchVolume: vi.fn(),
  autocomplete: vi.fn(),
  serp: vi.fn(),
  upsertKeywordMetric: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  waitUntil: (promise: Promise<unknown>) => promise,
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
vi.mock("@/server/lib/googleAdsKeywordPlanner", () => ({
  getKeywordPlannerClient: async () => ({
    keywords: {
      adsIdeas: mocks.adsIdeas,
      adsSearchVolume: mocks.adsSearchVolume,
    },
  }),
}));
vi.mock("@/server/lib/googleAutocomplete", () => ({
  fetchGoogleAutocomplete: mocks.autocomplete,
}));
vi.mock("@/server/lib/brightDataSerp", () => ({
  getBrightDataSerp: async () => ({ apiKey: "key", zone: "serp" }),
  fetchBrightDataSerp: mocks.serp,
}));
vi.mock("@/server/features/serp/services/difficultyEstimate", () => ({
  storedDifficultyEstimates: async () => new Map(),
}));
vi.mock(
  "@/server/features/keywords/repositories/KeywordResearchRepository",
  () => ({
    KeywordResearchRepository: {
      upsertKeywordMetric: mocks.upsertKeywordMetric,
    },
  }),
);

const customer = {
  organizationId: "org_1",
  userId: "user_1",
  userEmail: "user@example.com",
};

const input = {
  projectId: "project_1",
  keywords: ["hamburguesas"],
  locationCode: 2170,
  languageCode: "es",
  resultLimit: 150 as const,
  clickstream: false,
  groupKeywords: false,
};

beforeEach(() => {
  mocks.upsertKeywordMetric.mockResolvedValue(undefined);
});

it("phrase match adds Google autocomplete to the Planner's ideas and measures only the new keywords", async () => {
  mocks.adsIdeas.mockResolvedValue([
    { keyword: "hamburguesas", search_volume: 90500 },
    { keyword: "hamburguesas a domicilio", search_volume: 2900 },
    { keyword: "perros calientes", search_volume: 40500 },
  ]);
  mocks.autocomplete.mockResolvedValue({
    suggestions: [
      "hamburguesas a domicilio",
      "hamburguesas pereira",
      "hamburgueseria cerca",
    ],
    unavailable: null,
  });
  mocks.adsSearchVolume.mockResolvedValue([
    { keyword: "hamburguesas pereira", search_volume: 1300 },
  ]);
  const suggestions = { ...input, mode: "suggestions" as const };

  const result = await research(suggestions, customer);
  await research(suggestions, customer);

  expect(result.source).toBe("suggestions");
  expect(result.rows.map((row) => [row.keyword, row.searchVolume])).toEqual([
    ["hamburguesas", 90500],
    ["hamburguesas a domicilio", 2900],
    ["hamburguesas pereira", 1300],
  ]);
  expect(mocks.adsSearchVolume).toHaveBeenCalledTimes(1);
  expect(mocks.adsSearchVolume).toHaveBeenCalledWith(
    expect.objectContaining({ keywords: ["hamburguesas pereira"] }),
  );
  // The full result is cached like any research result.
  expect(mocks.autocomplete).toHaveBeenCalledTimes(1);
});

it("a city search on an unapproved Planner still lists Google's related searches and questions, without volume, and keeps nothing", async () => {
  mocks.serp.mockImplementation(async (_config, { keyword }) =>
    keyword === "hamburguesas"
      ? {
          organic: [],
          localPack: [],
          relatedSearches: [
            "hamburguesas pereira",
            "hamburguesas caseras",
            "receta hamburguesa",
            "hamburguesas cerca",
          ],
          peopleAlsoAsk: [
            {
              question: "¿Cuál es la mejor hamburguesa de Pereira?",
              answer: null,
              url: null,
              domain: null,
            },
          ],
        }
      : {
          organic: [],
          localPack: [],
          relatedSearches: ["hamburguesas pereira domicilio"],
          peopleAlsoAsk: [],
        },
  );
  mocks.adsSearchVolume.mockRejectedValue(
    new AppError("GOOGLE_ADS_ACCESS_PENDING"),
  );
  const related = {
    ...input,
    mode: "related" as const,
    locationName: "Pereira,Risaralda,Colombia",
  };

  const result = await research(related, customer);
  await research(related, customer);

  expect(result.rows.map((row) => [row.keyword, row.searchVolume])).toEqual([
    ["hamburguesas", null],
    ["hamburguesas pereira", null],
    ["hamburguesas caseras", null],
    ["receta hamburguesa", null],
    ["hamburguesas cerca", null],
    ["cuál es la mejor hamburguesa de pereira", null],
    ["hamburguesas pereira domicilio", null],
  ]);
  expect(result.notes).toEqual([
    expect.stringContaining("not approved Basic access"),
  ]);
  // A result with notes is not cached, but its Google pages are: the seed's
  // page and its first three related searches are bought once. No city
  // volume is asked for.
  expect(mocks.serp).toHaveBeenCalledTimes(4);
  expect(mocks.adsSearchVolume).toHaveBeenCalledTimes(2);
  expect(mocks.upsertKeywordMetric).not.toHaveBeenCalled();
});
