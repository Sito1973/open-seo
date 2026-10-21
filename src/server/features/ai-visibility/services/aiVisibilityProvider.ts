import { sumBy } from "remeda";
import {
  AiVisibilityRepository as repo,
  type ConfigurationRows,
} from "../repositories/AiVisibilityRepository";
import { AiVisibilityError } from "./aiVisibilityErrors";
import { activeAiPrompts, trackerEngines } from "./aiVisibilityConfiguration";
import {
  brightDataBudgetUsage,
  getBrightDataSerp,
} from "@/server/lib/brightDataSerp";
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
  type AiRequestBudget,
  type AiScheduleInterval,
} from "@/shared/ai-visibility";
import { aiEngineSchema } from "@/types/schemas/ai-visibility";

interface AiCollectionProvider {
  /**
   * "standin": a self-hosted install without DataForSEO for other features,
   * where each engine has its own free provider.
   */
  name: "dataforseo" | "standin";
  engines: AiEngine[];
}

/** Engines collected through a free stand-in, each from its own budget. */
type AiStandInEngine = Extract<
  AiEngine,
  "google_ai_mode" | "google_ai_overview"
>;

const DATAFORSEO_ENGINES = aiEngineSchema.options.filter(
  (engine) => engine !== "google_ai_mode",
);

const STAND_IN_PROVIDERS =
  "Google AI Mode through SerpApi (SERPAPI_API_KEY) and Google AI Overviews through Bright Data (BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE)";

/**
 * Who collects answers on this server, and which engines. DataForSEO collects
 * every engine but Google AI Mode. Without it (or with
 * DATAFORSEO_SCOPE=backlinks), a self-hosted install collects through
 * stand-ins: Google AI Mode through SerpApi and Google AI Overviews through
 * Bright Data's SERP API. Null: setup only.
 */
export async function aiCollectionProvider(): Promise<AiCollectionProvider | null> {
  if (await getDataforseoKey("other"))
    return { name: "dataforseo", engines: DATAFORSEO_ENGINES };
  const [serpApiKey, brightData] = await Promise.all([
    getSerpApiKey(),
    getBrightDataSerp(),
  ]);
  const engines = aiEngineSchema.options.filter(
    (engine) =>
      (engine === "google_ai_mode" && !!serpApiKey) ||
      (engine === "google_ai_overview" && !!brightData),
  );
  return engines.length ? { name: "standin", engines } : null;
}

/** The engines a tracker can use here. Without a provider, DataForSEO's. */
export function aiProviderEngines(
  provider: AiCollectionProvider | null,
): AiEngine[] {
  return provider?.engines ?? DATAFORSEO_ENGINES;
}

/** Refuses engines this server cannot collect, naming them and why. */
export function requireAiEngines(
  engines: readonly AiEngine[],
  provider: AiCollectionProvider | null,
) {
  const available = aiProviderEngines(provider);
  const unavailable = engines.filter((engine) => !available.includes(engine));
  if (!unavailable.length) return;
  const labels = (list: AiEngine[]) =>
    list.map((engine) => AI_ENGINE_LABELS[engine]).join(" and ");
  throw new AiVisibilityError(
    "ENGINE_UNAVAILABLE",
    `${labels(unavailable)} cannot collect answers on this server. ${
      provider?.name === "standin"
        ? `Without DataForSEO (DATAFORSEO_API_KEY unset or DATAFORSEO_SCOPE=backlinks) it collects ${labels(available)} only: ${STAND_IN_PROVIDERS}, each when its keys are set. Remove the other engines.`
        : "Google AI Mode is collected through SerpApi, only on self-hosted servers without DataForSEO (DATAFORSEO_API_KEY unset or DATAFORSEO_SCOPE=backlinks). Remove it."
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

/** How each stand-in's budget is named, and what else uses it. */
const STAND_IN_BUDGETS: Record<
  AiStandInEngine,
  { unit: string; sharedWith: string }
> = {
  google_ai_mode: { unit: "SerpApi searches", sharedWith: "" },
  google_ai_overview: {
    unit: "Bright Data requests",
    sharedWith: ", which rank tracking and SERP tools also use",
  },
};

async function standInUsage(engine: AiStandInEngine) {
  return engine === "google_ai_mode"
    ? {
        usedThisMonth: await serpApiSearchesUsed(),
        monthlyBudget: SERPAPI_MONTHLY_BUDGET,
      }
    : brightDataBudgetUsage();
}

/**
 * The requests a tracker's checks use from one stand-in's budget: one per
 * prompt. perMonth adds the busiest month of every other enabled tracker of
 * that engine on this server, which shares the budget.
 */
export async function aiSearchBudget(
  engine: AiStandInEngine,
  perCheck: number,
  interval: AiScheduleInterval,
  trackerId: string,
): Promise<AiRequestBudget> {
  const [{ usedThisMonth, monthlyBudget }, others] = await Promise.all([
    standInUsage(engine),
    repo.countOtherEnginePrompts(trackerId, engine),
  ]);
  return {
    perCheck,
    perMonth:
      perCheck * MAX_CHECKS_PER_MONTH[interval] +
      sumBy(
        others,
        (row) => row.prompts * MAX_CHECKS_PER_MONTH[row.scheduleInterval],
      ),
    monthlyBudget,
    usedThisMonth,
    remaining: Math.max(0, monthlyBudget - usedThisMonth),
  };
}

/**
 * Refuses a stand-in schedule whose check needs more SerpApi searches than
 * SerpApi allows in an hour, or which, with every other enabled tracker of
 * the same engine on this server, could need more a month than that
 * stand-in's budget.
 */
export async function requireAiScheduleBudget(
  config: ConfigurationRows,
  interval: AiScheduleInterval,
) {
  if ((await aiCollectionProvider())?.name !== "standin") return;
  const prompts = activeAiPrompts(config).length;
  const engines = trackerEngines(config.tracker);
  const searches = prompts * serpApiSearchesPerCheck(engines);
  if (searches > SERPAPI_HOURLY_LIMIT)
    throw new AiVisibilityError(
      "SEARCH_BUDGET_EXCEEDED",
      `A check of these prompts needs ${searches} SerpApi searches, more than the ${SERPAPI_HOURLY_LIMIT} an hour SerpApi's free plan allows. Track fewer prompts or pause tracking.`,
    );
  for (const engine of ["google_ai_mode", "google_ai_overview"] as const) {
    if (!prompts || !engines.includes(engine)) continue;
    const { perMonth, monthlyBudget } = await aiSearchBudget(
      engine,
      prompts,
      interval,
      config.tracker.id,
    );
    const own = prompts * MAX_CHECKS_PER_MONTH[interval];
    const { unit, sharedWith } = STAND_IN_BUDGETS[engine];
    if (perMonth > monthlyBudget)
      throw new AiVisibilityError(
        "SEARCH_BUDGET_EXCEEDED",
        `A ${interval} schedule of these prompts needs up to ${own} ${unit} a month${perMonth > own ? `, and this server's other ${AI_ENGINE_LABELS[engine]} trackers up to ${perMonth - own}` : ""}: more than this server's budget of ${monthlyBudget}${sharedWith}. Track fewer prompts, choose a longer interval, or pause tracking.`,
      );
  }
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

/**
 * Refuses a check that this month's Bright Data budget, shared with rank
 * tracking and SERP tools, cannot cover: one request per Google AI Overviews
 * answer. Nothing is collected or counted.
 */
export async function requireBrightDataRequests(requests: number) {
  const { usedThisMonth, monthlyBudget } = await brightDataBudgetUsage();
  const remaining = Math.max(0, monthlyBudget - usedThisMonth);
  if (requests > remaining)
    throw new AiVisibilityError(
      "SEARCH_BUDGET_EXHAUSTED",
      `This check needs ${requests} Bright Data ${requests === 1 ? "request" : "requests"}, but this server's monthly Bright Data budget, which rank tracking and SERP tools also use, has ${remaining} of ${monthlyBudget} left (it resets on the 1st, UTC). No request was sent.`,
    );
}
