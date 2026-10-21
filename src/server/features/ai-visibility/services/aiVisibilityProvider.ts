import { sumBy } from "remeda";
import {
  AiVisibilityRepository as repo,
  type ConfigurationRows,
} from "../repositories/AiVisibilityRepository";
import { AiVisibilityError } from "./aiVisibilityErrors";
import { activeAiPrompts, trackerEngines } from "./aiVisibilityConfiguration";
import { getDataforseoKey } from "@/server/lib/runtime-env";
import {
  fetchSerpApiAccount,
  getSerpApiKey,
  SERPAPI_HOURLY_LIMIT,
  SERPAPI_MONTHLY_BUDGET,
  serpApiSearchesUsed,
} from "@/server/lib/serpApiAiMode";
import {
  AI_ENGINE_LABELS,
  type AiEngine,
  type AiScheduleInterval,
  type AiSearchBudget,
} from "@/shared/ai-visibility";
import { aiEngineSchema } from "@/types/schemas/ai-visibility";

type AiCollectionProvider = "dataforseo" | "serpapi";

/**
 * Who collects answers on this server. DataForSEO collects every engine but
 * Google AI Mode. Without it (or with DATAFORSEO_SCOPE=backlinks), a
 * self-hosted install with SERPAPI_API_KEY collects Google AI Mode only,
 * through SerpApi. Null: setup only.
 */
export async function aiCollectionProvider(): Promise<AiCollectionProvider | null> {
  if (await getDataforseoKey("other")) return "dataforseo";
  return (await getSerpApiKey()) ? "serpapi" : null;
}

/** The engines a tracker can use here. Without a provider, DataForSEO's. */
export function aiProviderEngines(
  provider: AiCollectionProvider | null,
): AiEngine[] {
  return aiEngineSchema.options.filter(
    (engine) => (engine === "google_ai_mode") === (provider === "serpapi"),
  );
}

/** Refuses engines this server cannot collect, naming them and why. */
export function requireAiEngines(
  engines: readonly AiEngine[],
  provider: AiCollectionProvider | null,
) {
  const available = aiProviderEngines(provider);
  const unavailable = engines.filter((engine) => !available.includes(engine));
  if (!unavailable.length) return;
  throw new AiVisibilityError(
    "ENGINE_UNAVAILABLE",
    `${unavailable.map((engine) => AI_ENGINE_LABELS[engine]).join(" and ")} cannot collect answers on this server. ${
      provider === "serpapi"
        ? "Without DataForSEO (DATAFORSEO_API_KEY unset or DATAFORSEO_SCOPE=backlinks) it collects Google AI Mode only, through SerpApi. Remove the other engines."
        : "Google AI Mode is collected through SerpApi, only on self-hosted servers without DATAFORSEO_API_KEY. Remove it."
    }`,
  );
}

/**
 * The most checks a schedule runs in one month: a budget must hold in a
 * 31-day month with five weekly slots.
 */
const MAX_CHECKS_PER_MONTH: Record<AiScheduleInterval, number> = {
  daily: 31,
  weekly: 5,
  monthly: 1,
};

/** SerpApi searches one check of these engines uses: one per AI Mode answer. */
export function serpApiSearchesPerCheck(engines: readonly AiEngine[]) {
  return engines.filter((engine) => engine === "google_ai_mode").length;
}

/**
 * The searches a tracker's checks use. perMonth adds the busiest month of
 * every other enabled Google AI Mode tracker on this server, which shares the
 * budget.
 */
export async function aiSearchBudget(
  perCheck: number,
  interval: AiScheduleInterval,
  trackerId: string,
): Promise<AiSearchBudget> {
  const [usedThisMonth, others] = await Promise.all([
    serpApiSearchesUsed(),
    repo.countOtherAiModePrompts(trackerId),
  ]);
  return {
    perCheck,
    perMonth:
      perCheck * MAX_CHECKS_PER_MONTH[interval] +
      sumBy(
        others,
        (row) => row.prompts * MAX_CHECKS_PER_MONTH[row.scheduleInterval],
      ),
    monthlyBudget: SERPAPI_MONTHLY_BUDGET,
    hourlyLimit: SERPAPI_HOURLY_LIMIT,
    usedThisMonth,
    remaining: Math.max(0, SERPAPI_MONTHLY_BUDGET - usedThisMonth),
  };
}

/**
 * Refuses a SerpApi schedule whose check needs more searches than SerpApi
 * allows in an hour, or which, with every other enabled Google AI Mode
 * tracker on this server, could need more a month than the shared budget.
 */
export async function requireAiScheduleBudget(
  config: ConfigurationRows,
  interval: AiScheduleInterval,
) {
  if ((await aiCollectionProvider()) !== "serpapi") return;
  const perCheck =
    activeAiPrompts(config).length *
    serpApiSearchesPerCheck(trackerEngines(config.tracker));
  if (!perCheck) return;
  if (perCheck > SERPAPI_HOURLY_LIMIT)
    throw new AiVisibilityError(
      "SEARCH_BUDGET_EXCEEDED",
      `A check of these prompts needs ${perCheck} SerpApi searches, more than the ${SERPAPI_HOURLY_LIMIT} an hour SerpApi's free plan allows. Track fewer prompts or pause tracking.`,
    );
  const { perMonth } = await aiSearchBudget(
    perCheck,
    interval,
    config.tracker.id,
  );
  const own = perCheck * MAX_CHECKS_PER_MONTH[interval];
  if (perMonth > SERPAPI_MONTHLY_BUDGET)
    throw new AiVisibilityError(
      "SEARCH_BUDGET_EXCEEDED",
      `A ${interval} schedule of these prompts needs up to ${own} SerpApi searches a month${perMonth > own ? `, and this server's other Google AI Mode trackers up to ${perMonth - own}` : ""}: more than this server's budget of ${SERPAPI_MONTHLY_BUDGET}. Track fewer prompts, choose a longer interval, or pause tracking.`,
    );
}

/**
 * Refuses a check that SerpApi cannot finish: more searches than this
 * month's budget has left, or than SerpApi reports left on the plan or in
 * this hour (account.json uses no search). Nothing is collected or counted.
 */
export async function requireSerpApiSearches(searches: number) {
  const apiKey = await getSerpApiKey();
  if (!apiKey || !searches) return;
  const remaining = SERPAPI_MONTHLY_BUDGET - (await serpApiSearchesUsed());
  const account = await fetchSerpApiAccount(apiKey);
  // Without SerpApi's count, assume the free plan's whole hour is left.
  const hourSearchesLeft = account?.hourSearchesLeft ?? SERPAPI_HOURLY_LIMIT;
  const shortfall =
    searches > remaining
      ? `this server's monthly SerpApi budget has ${Math.max(0, remaining)} of ${SERPAPI_MONTHLY_BUDGET} searches left (it resets on the 1st, UTC)`
      : account && searches > account.planSearchesLeft
        ? `SerpApi reports ${account.planSearchesLeft} searches left on the plan until it renews`
        : searches > hourSearchesLeft
          ? `SerpApi allows ${Math.max(0, hourSearchesLeft)} more searches this hour (the free plan allows ${SERPAPI_HOURLY_LIMIT} an hour)`
          : null;
  if (shortfall)
    throw new AiVisibilityError(
      "SEARCH_BUDGET_EXHAUSTED",
      `This check needs ${searches} SerpApi ${searches === 1 ? "search" : "searches"}, but ${shortfall}. No search was sent.`,
    );
}
