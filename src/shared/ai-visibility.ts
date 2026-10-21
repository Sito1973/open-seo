import {
  getIsoCountryCode,
  LOCATION_OPTIONS,
  SERP_LANGUAGE_OPTIONS,
} from "@/shared/keyword-locations";
import { supportsWebSearchCountry } from "@/shared/prompt-search-countries";

export type AiEngine =
  | "chatgpt"
  | "gemini"
  | "google_ai_overview"
  | "google_ai_mode"
  | "claude"
  | "perplexity";
export const AI_ENGINE_LABELS: Record<AiEngine, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  google_ai_overview: "Google AI Overviews",
  google_ai_mode: "Google AI Mode",
  claude: "Claude",
  perplexity: "Perplexity",
};
/**
 * Engines DataForSEO has no LLM Scraper for. Their answers come from the live
 * LLM Responses API, at live API pricing. Each name is also its API model slug.
 */
export type AiModelApiEngine = Extract<AiEngine, "claude" | "perplexity">;
export function aiEngineUsesModelApi(
  engine: AiEngine,
): engine is AiModelApiEngine {
  return engine === "claude" || engine === "perplexity";
}
/**
 * Raw DataForSEO USD for one answer, standard queue. AI Overviews is one
 * organic SERP page ($0.0006) plus the async overview load ($0.0006).
 */
export const AI_RECORD_COST_USD = 0.0012;
/**
 * Raw DataForSEO USD for one live answer, used by manual runs. AI Overviews is
 * one live organic SERP page ($0.002) plus the async overview load ($0.002).
 */
export const AI_LIVE_RECORD_COST_USD = 0.004;
export type AiScheduleInterval = "daily" | "weekly" | "monthly";
export type AiObservationStatus = "pending" | "completed" | "failed";
/** Prompts without a chosen topic are grouped here. */
export const AI_DEFAULT_TOPIC = "General";
export interface AiPrompt {
  id: string;
  text: string;
  topic: string;
  paused: boolean;
  archived: boolean;
  branded: boolean;
  /** Whether any run has collected answer text for this prompt. */
  hasResults: boolean;
}
export interface AiBrand {
  name: string;
  domain: string;
  own: boolean;
}
export interface AiTracker {
  id: string;
  projectId: string;
  enabled: boolean;
  locationCode: number;
  languageCode: string;
  scheduleInterval: AiScheduleInterval;
  nextCheckAt: string | null;
  lastSkipReason: string | null;
  createdAt: string;
}
export interface AiCapability {
  engine: AiEngine;
  label: string;
  /** Countries from the shared market list this engine cannot collect in. */
  unsupportedLocationCodes: number[];
  maxPromptLength: number;
  note: string;
  /** Every run asks the model's API, at live API pricing. */
  modelApi: boolean;
}
export interface AiRun {
  id: string;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  trigger: "baseline" | "scheduled" | "manual";
  expected: number;
  completed: number;
  failed: number;
  pending: number;
  createdAt: string;
  completedAt: string | null;
  pollAfterSeconds: number;
}
export interface AiTrackerState {
  configured: boolean;
  tracker: AiTracker | null;
  /** Topics of unarchived prompts, in name order. */
  topics: string[];
  prompts: AiPrompt[];
  brands: AiBrand[];
  engines: AiEngine[];
  capabilities: AiCapability[];
  recentRuns: AiRun[];
  providerConfigured: boolean;
}
export interface AiResearchedPrompt {
  text: string;
  /** Near-duplicate prompts merged into this one. */
  variants: string[];
  sources: {
    domain: string;
    url: string;
    title: string | null;
    own: boolean;
  }[];
  ownDomainCited: boolean;
  brandMentioned: boolean;
  tracked: boolean;
  /** Google candidates only: where Google showed this text. */
  origins?: AiPromptCandidateOrigin[];
  /** Google candidates only: a labeled search demand signal, never AI prompt volume. */
  volume?: AiPromptCandidateVolume | null;
  /** Google candidates only: the tracked prompt's last answer, else Google's People Also Ask answer. */
  answer?: AiPromptCandidateAnswer | null;
}
/**
 * On a self-hosted server without DataForSEO, Prompt Research lists Google's
 * own candidates instead of DataForSEO's ChatGPT question database.
 */
export type AiPromptCandidateOrigin =
  | "tracked"
  | "people_also_ask"
  | "related_search"
  | "autocomplete"
  | "search_console"
  | "business_profile";
export const AI_PROMPT_CANDIDATE_ORIGIN_LABELS: Record<
  AiPromptCandidateOrigin,
  string
> = {
  tracked: "Tracked",
  people_also_ask: "People Also Ask",
  related_search: "Related search",
  autocomplete: "Autocomplete",
  search_console: "Search Console",
  business_profile: "Business Profile",
};
export interface AiPromptCandidateVolume {
  /**
   * business_profile: Business Profile search impressions, last 3 complete
   * months. search_console: the site's Search Console impressions, last 3
   * months. keyword_planner: Keyword Planner average monthly searches.
   */
  source: "business_profile" | "search_console" | "keyword_planner";
  value: number;
  /** Business Profile reports only "fewer than value" for small counts. */
  below: boolean;
}
export const AI_PROMPT_CANDIDATE_VOLUME_LABELS: Record<
  AiPromptCandidateVolume["source"],
  string
> = {
  business_profile: "Business Profile impressions, last 3 months",
  search_console: "Search Console impressions, last 3 months",
  keyword_planner: "Keyword Planner searches a month",
};
export type AiPromptCandidateAnswer =
  | {
      kind: "last_answer";
      engine: AiEngine;
      collectedAt: string | null;
      /** Plain text, shortened. */
      text: string;
    }
  | { kind: "people_also_ask"; text: string };
export interface AiPromptResearchResult {
  keyword: string;
  /** Most common questions first. */
  prompts: AiResearchedPrompt[];
  /**
   * Set when the prompts are Google's raw candidates: guidance says how to
   * rewrite them, notes why a source is missing.
   */
  withoutModel?: { guidance: string; notes: string[] };
}
export interface AiCostEstimate {
  promptCount: number;
  engineCount: number;
  observations: number;
  providerCostUsd: number;
  costUsd: number;
  costCredits: number;
  /** A one-off Run now check collects live answers, at the live price. */
  runNowCostUsd: number;
  runNowCostCredits: number;
  scheduleInterval: AiScheduleInterval;
  checksPerMonth: number;
  monthlyCostUsd: number;
  currency: "USD";
  warnings: string[];
  /** Self-hosted Google AI Mode through SerpApi: free, but searches are limited. */
  searchBudget: AiSearchBudget | null;
  /**
   * Self-hosted Google AI Overviews through Bright Data: free, but each answer
   * uses a request from the Bright Data budget that rank tracking also uses.
   */
  brightDataBudget: AiRequestBudget | null;
}
/** A stand-in provider's free requests for one engine's answers. */
export interface AiRequestBudget {
  /** Requests one check uses: one per answer of the engine. */
  perCheck: number;
  /**
   * perCheck times the most checks the schedule can run in one month, plus
   * the same for every other enabled tracker of the engine on this server.
   */
  perMonth: number;
  /** This server's monthly budget, below the provider's free requests. */
  monthlyBudget: number;
  usedThisMonth: number;
  /** Budget left this month (UTC). */
  remaining: number;
}
/** SerpApi's searches for Google AI Mode answers. */
export interface AiSearchBudget extends AiRequestBudget {
  /** The free plan's searches an hour: the most one check can use. */
  hourlyLimit: number;
}
export interface AiBrandResult {
  name: string;
  domain: string;
  own: boolean;
  mentioned: boolean;
  cited: boolean;
  /** Character offset of the first mention in the answer, or null. */
  firstMention: number | null;
}
export interface AiObservationRow {
  id: string;
  runId: string;
  promptId: string;
  prompt: string;
  topic: string;
  branded: boolean;
  engine: AiEngine;
  status: AiObservationStatus;
  answerStatus: "answered" | "no_answer" | null;
  brands: AiBrandResult[];
  citationCount: number;
  collectedAt: string | null;
  error: string | null;
}
export interface AiBrandSummary {
  name: string;
  domain: string;
  own: boolean;
  /** Answered collections in scope; the denominator for both rates. */
  answers: number;
  mentions: number;
  citations: number;
  /** Sum and count of mention positions (1 = named first) in answers naming it. */
  positionTotal: number;
  positionCount: number;
}
export interface AiResults {
  runId: string | null;
  run: AiRun | null;
  rows: AiObservationRow[];
  totalCount: number;
  nextCursor: string | null;
  summaries: AiBrandSummary[];
  coverage: {
    expected: number;
    completed: number;
    noAnswer: number;
    failed: number;
    pending: number;
  };
  appliedFilters: {
    topic?: string;
    engines?: AiEngine[];
    competitorGap: boolean;
    branded: string;
  };
  truncated: boolean;
}
export interface AiSource {
  url: string;
  domain: string;
  title: string | null;
  position: number;
  /**
   * Google AI Mode only: "inline" when the answer text links the page,
   * "reference" when only its sources list does. Null when not recorded
   * (other engines, or an answer whose text linked no source).
   */
  placement: "inline" | "reference" | null;
  /** 1 = the first cited page the answer text links; null unless inline. */
  inlineOrder: number | null;
}
export interface AiAnswer {
  observation: AiObservationRow;
  answerText: string | null;
  answerMarkdown: string | null;
  /** Cited pages, in the engine's order. */
  sources: AiSource[];
  /** Where each mentioned brand appears in answerText. */
  mentions: { domain: string; spans: { start: number; end: number }[] }[];
  requestedLocationCode: number;
  requestedLanguageCode: string;
  truncated: boolean;
}
export interface AiSourceRow {
  key: string;
  url: string | null;
  domain: string;
  title: string | null;
  ownership: "own" | "competitor" | "other";
  answerCount: number;
  promptCount: number;
  /** The tracked prompts whose answers cited this source. */
  promptIds: string[];
  engines: { engine: AiEngine; answerCount: number }[];
  observationIds: string[];
  truncated: boolean;
}
export interface AiSources {
  runId: string | null;
  rows: AiSourceRow[];
  totalCount: number;
  nextCursor: string | null;
  coverage: AiResults["coverage"];
  appliedFilters: AiResults["appliedFilters"] & {
    ownership: "all" | "own" | "competitor" | "other";
  };
  groupBy: "url" | "domain";
  truncated: boolean;
}

export interface AiTrendCoverage {
  runs: number;
  expected: number;
  answered: number;
  noAnswer: number;
  failed: number;
}
export interface AiTrendPeriod {
  start: string;
  end: string;
  coverage: AiTrendCoverage;
}
/**
 * One metric over prompt/engine/market/brand-identity cells. Each rate is the mean of the
 * cells' own rates, so every cell counts equally in both periods.
 */
export interface AiTrendMetric {
  /** Mean over matched cells, or over every current cell without a comparison. */
  current: number | null;
  previous: number | null;
  /** Percentage points, only when the comparison is fair. */
  change: number | null;
  matchedCells: number;
  currentCells: number;
  previousCells: number;
}
export type AiTrendComparison =
  | "comparable"
  | "incomplete"
  | "scope_changed"
  | "no_previous"
  | "no_data";
export interface AiTrend {
  days: number;
  comparison: AiTrendComparison;
  current: AiTrendPeriod;
  previous: AiTrendPeriod;
  mentions: AiTrendMetric;
  citations: AiTrendMetric;
  engines: {
    engine: AiEngine;
    mentions: AiTrendMetric;
    citations: AiTrendMetric;
  }[];
  /** One point per finished baseline or scheduled run, oldest first. */
  runs: {
    runId: string;
    createdAt: string;
    mentionRate: number | null;
    citationRate: number | null;
    coverage: AiTrendCoverage;
  }[];
}

/**
 * Countries from the shared market list that DataForSEO cannot collect for an
 * engine. Keep in sync with each engine's DataForSEO locations endpoint.
 */
export const AI_UNSUPPORTED_LOCATIONS: Record<AiEngine, readonly number[]> = {
  chatgpt: [2275],
  gemini: [],
  google_ai_overview: [],
  // SerpApi asks Google from the project's country. Where Google shows no AI
  // Mode, the answer is a no-answer result, excluded from rates.
  google_ai_mode: [],
  claude: liveUnsupportedLocations("claude"),
  perplexity: liveUnsupportedLocations("perplexity"),
};

/** Countries a live engine's web search does not accept. */
function liveUnsupportedLocations(engine: AiModelApiEngine): number[] {
  return LOCATION_OPTIONS.filter(
    (option) =>
      !supportsWebSearchCountry(
        engine,
        getIsoCountryCode(option.code).toUpperCase(),
      ),
  ).map((option) => option.code);
}

/** "In progress" while a collection is unfinished. */
export function aiObservationStatusLabel(status: AiObservationStatus): string {
  return status === "pending" ? "In progress" : status;
}

/**
 * An empty Google result means Google showed no AI answer. A no-answer result
 * with the provider's note (an AI Overview Bright Data returned without its
 * text) had an answer whose text was not captured.
 */
export function aiNoAnswerLabel(
  engine: AiEngine,
  note?: string | null,
): string {
  if (note) return "Answer without text";
  if (engine === "google_ai_overview") return "No AI Overview shown";
  if (engine === "google_ai_mode") return "No AI Mode answer shown";
  return "No substantive answer";
}

/** The selected engines that cannot collect in this country. */
export function aiEnginesWithoutLocation(
  engines: readonly AiEngine[],
  locationCode: number,
): AiEngine[] {
  return engines.filter((engine) =>
    AI_UNSUPPORTED_LOCATIONS[engine].includes(locationCode),
  );
}

export function aiCountryLabel(locationCode: number): string {
  return (
    LOCATION_OPTIONS.find((option) => option.code === locationCode)?.label ??
    `Location ${locationCode}`
  );
}

/** "Bulgaria · Bulgarian" */
export function aiMarketLabel(market: {
  locationCode: number;
  languageCode: string;
}): string {
  const language =
    SERP_LANGUAGE_OPTIONS.find((option) => option.code === market.languageCode)
      ?.label ?? market.languageCode;
  return `${aiCountryLabel(market.locationCode)} · ${language}`;
}
