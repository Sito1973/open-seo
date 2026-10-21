import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConfiguration, startRun, aiCollectionProvider } = vi.hoisted(() => ({
  getConfiguration: vi.fn(),
  startRun: vi.fn(),
  aiCollectionProvider: vi.fn(),
}));
vi.mock("../repositories/AiVisibilityRepository", () => ({
  AiVisibilityRepository: { getConfiguration },
}));
vi.mock("./aiVisibilityRuns", () => ({ startRun }));
vi.mock("./aiVisibilityProvider", () => ({ aiCollectionProvider }));

import {
  prepareWebsiteTracking,
  startWebsiteTrackingRun,
} from "./websiteTrackingSetup";
import { configuration, customer } from "./aiVisibilityTestFixtures";

beforeEach(() => {
  getConfiguration.mockResolvedValue(null);
  aiCollectionProvider.mockResolvedValue("dataforseo");
});

const topic = (name: string) => ({
  name,
  prompts: [1, 2, 3, 4, 5].map((n) => `${name} question ${n}?`),
});

describe("prepareWebsiteTracking", () => {
  it("seeds tracking with only the first three of the five research topics", async () => {
    const tracking = await prepareWebsiteTracking(
      {
        projectId: "4a5b6c7d-0000-4000-8000-000000000000",
        suggestedTopics: [
          "rank tracker",
          "seo tool",
          "backlink checker",
          "keyword research",
          "site audit",
        ].map(topic),
      },
      { locationCode: 2840, languageCode: "en" },
    );

    expect([...new Set(tracking?.prompts.map((row) => row.topic))]).toEqual([
      "rank tracker",
      "seo tool",
      "backlink checker",
    ]);
    expect(tracking?.prompts).toHaveLength(15);
  });

  it("seeds Google AI Mode on a SerpApi-only server, which collects nothing else", async () => {
    aiCollectionProvider.mockResolvedValue("serpapi");

    const tracking = await prepareWebsiteTracking(
      { projectId: "project", suggestedTopics: [topic("burgers")] },
      { locationCode: 2840, languageCode: "en" },
    );

    expect(tracking?.tracker).toMatchObject({
      googleAiMode: true,
      chatgpt: false,
      gemini: false,
    });
  });
});

describe("startWebsiteTrackingRun", () => {
  it("starts the baseline, and a run that cannot start leaves setup saved", async () => {
    const config = configuration();
    getConfiguration.mockResolvedValue(config);
    startRun.mockRejectedValue(new Error("DATAFORSEO_API_KEY is missing"));

    await expect(
      startWebsiteTrackingRun("project", customer),
    ).resolves.toBeUndefined();
    expect(startRun).toHaveBeenCalledWith(config, "baseline", customer);
  });
});
