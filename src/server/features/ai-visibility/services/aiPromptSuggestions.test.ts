import { beforeEach, expect, it, vi } from "vitest";

const {
  generateText,
  getConfiguration,
  listResearchKeywords,
  searchGoogleCandidates,
} = vi.hoisted(() => ({
  generateText: vi.fn(),
  getConfiguration: vi.fn(),
  listResearchKeywords: vi.fn(),
  searchGoogleCandidates: vi.fn(),
}));

vi.mock("ai", () => ({ generateText, Output: { object: vi.fn() } }));
vi.mock("@/server/billing/subscription", () => ({
  checkUsageCreditsDepleted: vi.fn(),
}));
vi.mock("@/server/billing/researchSpend", () => ({
  billResearchSpend: vi.fn(),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async () => undefined,
  getRequiredEnvValue: vi.fn(),
  isHostedServerAuthMode: async () => false,
}));
vi.mock("@/server/lib/brightDataSerp", () => ({
  getBrightDataSerp: async () => ({ apiKey: "bd-key", zone: "serp" }),
}));
vi.mock("@/server/features/serp/services/googleCandidates", () => ({
  projectSearchTracker: async () => ({ market: { locationName: null } }),
  searchGoogleCandidates,
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectForOrganization: async () => ({ id: "project", domain: "a.co" }),
  },
}));
vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  () => ({
    ProjectContextRepository: {
      listSections: async () => [],
      listCompetitors: async () => [],
    },
  }),
);
vi.mock("../repositories/AiVisibilityRepository", () => ({
  AiVisibilityRepository: { getConfiguration, listResearchKeywords },
}));

import { generateAiPrompts } from "./aiPromptSuggestions";
import { configuration, customer } from "./aiVisibilityTestFixtures";

beforeEach(() => {
  getConfiguration.mockResolvedValue(
    configuration({
      engines: ["chatgpt"],
      prompts: [{ text: "Best burgers in town?", topic: "burgers" }],
    }),
  );
  listResearchKeywords.mockResolvedValue(["burgers", "tacos"]);
  searchGoogleCandidates.mockResolvedValue({
    locationName: null,
    peopleAlsoAsk: [
      { question: "Best burgers in town?" },
      { question: "Where to eat tacos?" },
    ],
    relatedSearches: ["tacos near me", "WHERE to eat  tacos?"],
  });
});

it("without a model, suggests Google's new questions for the next research keyword", async () => {
  const result = await generateAiPrompts(
    {
      projectId: "project",
      excludePrompts: [],
      locationCode: 2840,
      languageCode: "en",
    },
    customer,
  );

  expect(generateText).not.toHaveBeenCalled();
  // "burgers" is already a topic, so the next research keyword is searched.
  expect(searchGoogleCandidates).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ query: "tacos" }),
  );
  expect(result).toMatchObject({
    topic: "tacos",
    // Saved prompts and case/whitespace variants are dropped.
    prompts: ["Where to eat tacos?", "tacos near me"],
  });
  expect(result.withoutModel?.guidance).toContain("save_ai_visibility_tracker");
});
