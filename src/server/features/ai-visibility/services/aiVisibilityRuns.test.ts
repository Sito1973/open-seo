import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiObservations, aiRuns, projects } from "@/db/schema";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { runCheck } from "./aiVisibilityRuns";
import { saveTracker } from "./aiVisibilitySetup";
import { getTracker } from "./aiVisibilityState";
import { configuration, customer } from "./aiVisibilityTestFixtures";

const { testDb, workflow, keys } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    workflow: { create: vi.fn(), get: vi.fn() },
    keys: { dataforseo: vi.fn(), serpApi: vi.fn() },
  };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1", AI_VISIBILITY_WORKFLOW: workflow },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  // DATAFORSEO_API_KEY
  getDataforseoKey: keys.dataforseo,
  // SERPAPI_API_KEY, which applies only without DATAFORSEO_API_KEY.
  getGoogleFallbackKey: keys.serpApi,
  isHostedServerAuthMode: async () => false,
}));

const projectId = "project";
const workflowStatus = (status: string) =>
  workflow.get.mockResolvedValue({ status: async () => ({ status }) });

/** A self-hosted server with SERPAPI_API_KEY and no DataForSEO key. */
function serpApiOnly() {
  keys.dataforseo.mockResolvedValue(null);
  keys.serpApi.mockResolvedValue("serpapi-key");
}

beforeEach(async () => {
  keys.dataforseo.mockResolvedValue("dataforseo-key");
  keys.serpApi.mockResolvedValue(null);
  await testDb.seedProject();
  await repo.saveConfiguration(
    configuration({
      engines: ["chatgpt"],
      prompts: [{ text: "Which SEO tools?" }, { text: "Is OpenSEO good?" }],
    }),
  );
  workflowStatus("running");
});

describe("AI visibility checks", () => {
  it("runs one check at a time and points a second start at the running one", async () => {
    const run = await runCheck({ projectId, maxCostUsd: 1 }, customer);
    expect(run).toMatchObject({ status: "queued", expected: 2, pending: 2 });
    expect(workflow.create).toHaveBeenCalledWith({
      id: run.id,
      params: { runId: run.id, customer: { ...customer, projectId } },
    });
    await expect(
      runCheck({ projectId, maxCostUsd: 1 }, customer),
    ).rejects.toMatchObject({ reason: "RUN_IN_PROGRESS", runId: run.id });
    expect(workflow.create).toHaveBeenCalledOnce();
  });

  it("fails a check whose workflow stopped, so it never blocks the next one", async () => {
    const stuck = await runCheck({ projectId, maxCostUsd: 1 }, customer);
    await testDb.db
      .update(aiRuns)
      .set({ status: "running", createdAt: "2026-01-01T00:00:00.000Z" });
    workflowStatus("errored");

    const next = await runCheck({ projectId, maxCostUsd: 1 }, customer);

    expect(next.id).not.toBe(stuck.id);
    expect(await repo.getRunInternal(stuck.id)).toMatchObject({
      status: "failed",
    });
    expect(
      await testDb.db
        .selectDistinct({ status: aiObservations.status })
        .from(aiObservations)
        .where(eq(aiObservations.runId, stuck.id)),
    ).toEqual([{ status: "failed" }]);
  });

  it("marks only prompts with collected answer text as having results", async () => {
    const run = await runCheck({ projectId, maxCostUsd: 1 }, customer);
    const answers = await repo.getObservations([run.id]);
    for (const answer of answers)
      await testDb.db
        .update(aiObservations)
        .set({
          status: "completed",
          // A completed collection without text means no answer was shown.
          answerMarkdown:
            answer.prompt === "Is OpenSEO good?" ? "OpenSEO is good." : null,
        })
        .where(eq(aiObservations.id, answer.id));

    const { prompts } = await getTracker({ projectId });

    expect(
      Object.fromEntries(
        prompts.map((prompt) => [prompt.text, prompt.hasResults]),
      ),
    ).toEqual({ "Is OpenSEO good?": true, "Which SEO tools?": false });
  });

  it("refuses a check that now costs more than the approved maximum", async () => {
    await expect(
      runCheck({ projectId, maxCostUsd: 0.001 }, customer),
    ).rejects.toMatchObject({ reason: "COST_LIMIT_EXCEEDED" });
    expect(await repo.listRuns(projectId)).toEqual([]);
  });

  it("moves a tracker to Google AI Mode on a SerpApi-only server, which collects nothing else", async () => {
    serpApiOnly();

    const { state } = await saveTracker({
      projectId,
      engines: ["google_ai_mode"],
    });

    expect(state.engines).toEqual(["google_ai_mode"]);
    expect(state.capabilities.map((c) => c.engine)).toEqual(["google_ai_mode"]);
    await expect(
      saveTracker({ projectId, engines: ["chatgpt"] }),
    ).rejects.toMatchObject({ reason: "ENGINE_UNAVAILABLE" });
  });

  it("refuses a SerpApi check that needs more searches than SerpApi has left, before any search", async () => {
    serpApiOnly();
    await saveTracker({ projectId, engines: ["google_ai_mode"] });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        plan_searches_left: 1,
        account_rate_limit_per_hour: 250,
        this_hour_searches: 0,
      }),
    );

    await expect(
      runCheck({ projectId, maxCostUsd: 0 }, customer),
    ).rejects.toMatchObject({ reason: "SEARCH_BUDGET_EXHAUSTED" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toMatch(/\/account\.json\?/);
    expect(await repo.listRuns(projectId)).toEqual([]);
  });

  it("refuses a SerpApi schedule whose check needs more searches than SerpApi allows in an hour", async () => {
    serpApiOnly();
    // 2 saved + 49 new prompts: 51 searches a check, over the 50 an hour.
    const prompts = Array.from({ length: 49 }, (_, index) => ({
      text: `Best burger in Pereira ${index}?`,
    }));

    await expect(
      saveTracker({ projectId, engines: ["google_ai_mode"], prompts }),
    ).rejects.toThrow("more than the 50 an hour");
  });

  it("refuses a SerpApi schedule that, with the server's other AI Mode trackers, could need more searches in a five-week month than the shared budget", async () => {
    serpApiOnly();
    // Another project's 40 weekly prompts: up to 200 searches a month.
    await testDb.db.insert(projects).values({
      id: "other-project",
      organizationId: "organization",
      name: "Other",
      domain: "other.example",
    });
    await repo.saveConfiguration(
      configuration(
        {
          engines: ["google_ai_mode"],
          prompts: Array.from({ length: 40 }, (_, index) => ({
            text: `Best pizza in Pereira ${index}?`,
          })),
        },
        "other-project",
      ),
    );

    // 2 saved + 7 new weekly prompts: up to 45 more, 245 in all, over 240.
    await expect(
      saveTracker({
        projectId,
        engines: ["google_ai_mode"],
        prompts: Array.from({ length: 7 }, (_, index) => ({
          text: `Best burger in Pereira ${index}?`,
        })),
      }),
    ).rejects.toMatchObject({ reason: "SEARCH_BUDGET_EXCEEDED" });
  });
});
