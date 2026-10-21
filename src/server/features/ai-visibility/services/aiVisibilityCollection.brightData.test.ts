import { beforeEach, expect, it, vi } from "vitest";
import { serpObservations } from "@/db/schema";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { collectAiLiveBatch, prepareAiRun } from "./aiVisibilityCollection";
import { configuration, customer } from "./aiVisibilityTestFixtures";

// Google AI Overviews through Bright Data's SERP API: a self-hosted install
// with BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE and no DataForSEO for other
// features. Answers and pages go to an in-memory SQLite.

const testDb = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return createAiVisibilityTestDb();
});
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: async () => false,
  // BRIGHTDATA_API_KEY, which applies only without DataForSEO.
  getGoogleFallbackKey: async () => "brightdata-key",
  // BRIGHTDATA_SERP_ZONE
  getOptionalEnvValue: async () => "serp-zone",
}));

const runId = "run";
const market = { locationCode: 2840, languageCode: "en" };

/** One parsed Google page in Bright Data's JSON envelope. */
function brightDataPage(aiOverview: Record<string, unknown>) {
  return Response.json({
    status_code: 200,
    headers: {},
    body: JSON.stringify({ organic: [], ai_overview: aiOverview }),
  });
}

beforeEach(async () => {
  await testDb.seedProject();
  const rows = configuration({
    engines: ["google_ai_overview"],
    prompts: [{ text: "Which SEO tools?" }],
  });
  await repo.saveConfiguration(rows);
  await repo.createRun(
    {
      id: runId,
      trackerId: rows.tracker.id,
      projectId: "project",
      trigger: "scheduled",
      status: "running",
      ...market,
      createdAt: "2026-09-05T12:00:00.000Z",
    },
    [
      {
        id: "answer",
        runId,
        promptId: rows.prompts[0].id,
        engine: "google_ai_overview",
        branded: false,
      },
    ],
  );
});

it("collects a scheduled Google AI Overview live from Bright Data, saving the answer and its page", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    brightDataPage({
      texts: [
        {
          snippet: "Popular tools:",
          list: [
            { snippet: "Ahrefs for backlinks." },
            { snippet: "OpenSEO for rank tracking." },
          ],
        },
      ],
      references: [
        { href: "https://openseo.so/rank-tracker", title: "Rank tracker" },
      ],
    }),
  );

  // Bright Data has no queue, so a scheduled run collects live too.
  const plan = await prepareAiRun(runId, customer);
  if (!plan.live) throw new Error("Expected a live run");
  for (const tasks of plan.batches)
    await collectAiLiveBatch(runId, customer, market, tasks);

  expect(await repo.getObservation("answer")).toMatchObject({
    status: "completed",
    answerMarkdown:
      "Popular tools:\n\n- Ahrefs for backlinks.\n- OpenSEO for rank tracking.",
  });
  const evidence = await repo.getEvidence(["answer"]);
  expect(evidence.sources).toMatchObject([
    { url: "https://openseo.so/rank-tracker", domain: "openseo.so" },
  ]);
  expect(evidence.matches).toContainEqual(
    expect.objectContaining({
      domain: "openseo.so",
      mentioned: true,
      cited: true,
    }),
  );
  expect(
    await testDb.db
      .select({
        keyword: serpObservations.keyword,
        origin: serpObservations.origin,
      })
      .from(serpObservations),
  ).toEqual([{ keyword: "which seo tools?", origin: "ai_visibility" }]);
});

it("saves an AI Overview that Bright Data returned without its text as no answer, with a note saying why", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    brightDataPage({
      references: [{ href: "https://ahrefs.com/blog/", title: "Ahrefs" }],
    }),
  );

  await collectAiLiveBatch(runId, customer, market, [
    { tag: "answer", prompt: "Which SEO tools?", engine: "google_ai_overview" },
  ]);

  // A completed answer without text is no answer, left out of visibility
  // rates, so the brand is never counted as missing from it.
  const answer = await repo.getObservation("answer");
  expect(answer).toMatchObject({ status: "completed", answerMarkdown: null });
  expect(answer?.error).toContain("without its text");
});
