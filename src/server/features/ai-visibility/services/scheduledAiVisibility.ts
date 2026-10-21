import { pruneAiVisibility } from "./aiVisibilityRetention";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AiVisibilityError } from "./aiVisibilityErrors";
import { activeAiPrompts, trackerEngines } from "./aiVisibilityConfiguration";
import { startRun } from "./aiVisibilityRuns";
import { serpApiSearchesPerCheck } from "./aiVisibilityProvider";
import { computeNextCheckAt } from "@/shared/rank-tracking";
import { SERPAPI_HOURLY_LIMIT } from "@/server/lib/serpApiAiMode";

// Answers admitted per tick. Like rank tracking's task-unit budget, it keeps
// task_get polling under DataForSEO's 2,000 requests a minute; the first start
// of a tick is always admitted so a large tracker never starves. Trackers past
// the budget stay due for the next tick, oldest first.
const SCHEDULED_ANSWER_BUDGET = 1000;
const TICK_DEADLINE_MS = 2 * 60_000;

/** Cron body: start a check for every due tracker. */
export async function runScheduledAiVisibility() {
  try {
    await pruneAiVisibility();
  } catch (error) {
    console.error("[ai-visibility] retention sweep failed", error);
  }
  const deadline = Date.now() + TICK_DEADLINE_MS;
  let started = 0;
  let answersStarted = 0;
  // SerpApi searches started this tick. Each check's pre-check reads
  // SerpApi's hourly count before earlier checks have searched, so checks
  // past the free plan's hour wait for a later tick instead.
  let searchesStarted = 0;
  for (const { tracker, organizationId } of await repo.listDue(
    new Date().toISOString(),
  )) {
    if (Date.now() >= deadline) break;
    // Unreachable: the due query only returns trackers with a next check.
    if (!tracker.nextCheckAt) continue;
    const observedNextCheckAt = tracker.nextCheckAt;
    try {
      const config = await repo.getConfiguration(tracker.projectId);
      if (!config) continue;
      const prompts = activeAiPrompts(config).length;
      const engines = trackerEngines(tracker);
      const answers = prompts * engines.length;
      const searches = prompts * serpApiSearchesPerCheck(engines);
      if (
        started > 0 &&
        (answersStarted + answers > SCHEDULED_ANSWER_BUDGET ||
          searchesStarted + searches > SERPAPI_HOURLY_LIMIT)
      )
        break;
      // Advance the schedule before starting, so a tracker that fails or is
      // busy moves on instead of staying due and crowding out the rest.
      const claimed = await repo.claimDueTracker({
        trackerId: tracker.id,
        observedNextCheckAt,
        values: {
          nextCheckAt: computeNextCheckAt(
            tracker.scheduleInterval,
            observedNextCheckAt,
          ),
          lastSkipReason: null,
        },
      });
      if (!claimed) continue;
      const first = !(await repo.getLatestScheduledRun(tracker.projectId));
      await startRun(config, first ? "baseline" : "scheduled", {
        organizationId,
        userId: "system",
        userEmail: "system@openseo.so",
        projectId: tracker.projectId,
      });
      started++;
      answersStarted += answers;
      searchesStarted += searches;
    } catch (error) {
      if (!(error instanceof AiVisibilityError))
        console.error("[ai-visibility] scheduled check failed to start", {
          trackerId: tracker.id,
          error,
        });
      await repo
        .updateTracker(tracker.id, {
          lastSkipReason:
            error instanceof AiVisibilityError
              ? error.message
              : "The scheduled check could not start.",
        })
        .catch(() => undefined);
    }
  }
}
