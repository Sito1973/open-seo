import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiVisibilityRepository as repo } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { configuration } from "@/server/features/ai-visibility/services/aiVisibilityTestFixtures";
import { brandLookupFromTracker } from "./brandLookupFromTracker";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));

const now = new Date("2026-10-21T12:00:00.000Z");

/** One Google AI Mode run of the given answers, each on its own prompt. */
async function seedRun(
  createdAt: string,
  answers: { markdown: string; sources?: string[] }[],
) {
  const config =
    (await repo.getConfiguration("project")) ??
    configuration({ engines: ["google_ai_mode"], prompts: [] });
  const prompts = answers.map((_, index) => ({
    id: `${createdAt}:prompt-${index}`,
    trackerId: config.tracker.id,
    topic: "General",
    text: `Question ${index}?`,
    paused: false,
    archived: false,
    createdAt,
  }));
  await repo.saveConfiguration({ ...config, prompts });
  await repo.createRun(
    {
      id: createdAt,
      trackerId: config.tracker.id,
      projectId: "project",
      trigger: "scheduled",
      status: "completed",
      locationCode: 2840,
      languageCode: "en",
      createdAt,
    },
    prompts.map((prompt) => ({
      id: prompt.id,
      runId: createdAt,
      promptId: prompt.id,
      engine: "google_ai_mode",
      branded: false,
    })),
  );
  for (const [index, answer] of answers.entries())
    await repo.persistAnswer({
      observationId: prompts[index].id,
      values: {
        status: "completed",
        collectedAt: createdAt,
        answerMarkdown: answer.markdown,
      },
      sources: (answer.sources ?? []).map((url, position) => ({
        id: crypto.randomUUID(),
        observationId: prompts[index].id,
        url,
        domain: new URL(url).hostname,
        title: null,
        position: position + 1,
      })),
      matches: [],
    });
}

beforeEach(() => testDb.seedProject());

describe("brandLookupFromTracker", () => {
  it("counts the last 12 weeks of answers that name the brand or cite its site", async () => {
    await seedRun("2026-06-01T08:00:00.000Z", [{ markdown: "OpenSEO" }]);
    await seedRun("2026-10-14T08:00:00.000Z", [
      { markdown: "OpenSEO is a good pick." },
      {
        markdown: "Ahrefs, per this guide.",
        sources: ["https://blog.openseo.so/guide"],
      },
      { markdown: "Ahrefs and Semrush." },
    ]);

    // The project's own domain also counts answers that only say its name.
    const result = await brandLookupFromTracker(
      {
        projectId: "project",
        query: "openseo.so",
        competitors: ["Ahrefs"],
        locationCode: 2840,
        languageCode: "en",
      },
      now,
    );

    expect(result.collectedAnswers).toEqual({
      answers: 3,
      engines: ["google_ai_mode"],
      since: "2026-10-14T08:00:00.000Z",
      truncated: false,
      ownBrand: true,
    });
    expect(result.perPlatform).toEqual([
      {
        platform: "google_ai_mode",
        status: "success",
        mentions: 2,
        aiSearchVolume: null,
      },
    ]);
    expect(result.topPages.map((page) => page.url)).toEqual([
      "https://blog.openseo.so/guide",
    ]);
    expect(result.shareOfVoice?.entries).toMatchObject([
      { label: "openseo.so", isTarget: true, mentions: 2 },
      { label: "Ahrefs", isTarget: false, mentions: 2 },
    ]);

    // The brand name also counts answers that only cite the project's site.
    const byName = await brandLookupFromTracker(
      {
        projectId: "project",
        query: "openseo",
        competitors: [],
        locationCode: 2840,
        languageCode: "en",
      },
      now,
    );
    expect(byName.totalMentions).toBe(2);
  });
});
