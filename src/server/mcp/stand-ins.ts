import { getBrightDataSerp } from "@/server/lib/brightDataSerp";
import { getKeywordPlannerConfig } from "@/server/lib/keywordPlannerConfig";
import {
  getDataforseoKey,
  getGoogleFallbackKey,
  usesGoogleFallbacks,
} from "@/server/lib/runtime-env";

/**
 * The stand-ins for DataForSEO a self-hosted install has set up, read from
 * the environment once per MCP request so tool descriptions can say what a
 * call really uses on this server.
 */
export type McpStandIns = {
  brightData: boolean;
  places: boolean;
  keywordPlanner: boolean;
  /** DataForSEO kept to backlinks under a monthly request budget. */
  dataforseoBacklinks: boolean;
};

/**
 * Null unless stand-ins apply (usesGoogleFallbacks): hosted installs and
 * installs that use DataForSEO for every feature keep DataForSEO's
 * descriptions and tools.
 */
export async function getMcpStandIns(): Promise<McpStandIns | null> {
  if (!(await usesGoogleFallbacks())) return null;
  const [brightData, places, keywordPlanner, backlinksKey] = await Promise.all([
    getBrightDataSerp(),
    getGoogleFallbackKey("GOOGLE_PLACES_API_KEY"),
    getKeywordPlannerConfig(),
    getDataforseoKey("backlinks"),
  ]);
  return {
    brightData: brightData !== null,
    places: places !== null,
    keywordPlanner: keywordPlanner !== null,
    dataforseoBacklinks: backlinksKey !== null,
  };
}

const NO_SOURCE =
  "This server has no source for it: it does not use DataForSEO for this and no stand-in covers it, so calls fail with PROVIDER_NOT_CONFIGURED.";

const KEYWORD_PLANNER =
  "No credits here: keyword data comes from the Google Ads Keyword Planner through the Google Ads account connected in the project's Settings → Integrations.";

const BRIGHT_DATA_BUDGET =
  "this server's monthly Bright Data budget, shared with rank tracking";

const PLACES_BUDGET = "this server's monthly Google Places budget";

const BACKLINKS =
  "No credits here: each DataForSEO request it sends counts against this server's monthly backlinks budget (DATAFORSEO_SCOPE=backlinks).";

// What replaces each DataForSEO tool's "Charges credits…" sentence where
// stand-ins apply. A tool missing here keeps a credit sentence that is false
// on such a server; the stand-in description test catches that.
const COST_NOTES: Record<string, (standIns: McpStandIns) => string> = {
  research_keywords: (s) => (s.keywordPlanner ? KEYWORD_PLANNER : NO_SOURCE),
  get_keyword_metrics: (s) => (s.keywordPlanner ? KEYWORD_PLANNER : NO_SOURCE),
  get_serp_results: (s) =>
    s.brightData
      ? `No credits here: each keyword sends one Bright Data request per 10 results of depth, from ${BRIGHT_DATA_BUDGET}.`
      : NO_SOURCE,
  find_serp_competitors: (s) =>
    s.brightData
      ? `No credits here: each keyword is one live Bright Data request for the top 10 organic results, from ${BRIGHT_DATA_BUDGET}.`
      : NO_SOURCE,
  search_local_businesses: (s) =>
    s.places
      ? `No credits here: it runs on Google Places Text Search, from ${PLACES_BUDGET}.`
      : NO_SOURCE,
  get_local_serp_results: (s) =>
    s.places
      ? `No credits here: it runs on Google Places Text Search (Maps results only, no Local Finder), from ${PLACES_BUDGET}.`
      : NO_SOURCE,
  get_local_rank_grid: (s) =>
    s.places
      ? "No credits here: it runs on Google Places, as the last sentences describe."
      : NO_SOURCE,
  get_business_profile: (s) =>
    `No credits here: the project's own listings come from Google Business Profile when it is connected to the project, and any other business from Google Places${s.places ? `, from ${PLACES_BUDGET}` : ", which needs GOOGLE_PLACES_API_KEY on this server"}.`,
  get_business_reviews: (s) =>
    `No credits here: the project's own listings' reviews come from Google Business Profile when it is connected to the project; any other business gets Google's 5 most relevant reviews from Google Places${s.places ? `, from ${PLACES_BUDGET}` : ", which needs GOOGLE_PLACES_API_KEY on this server"}.`,
  get_business_updates: () =>
    "No credits here: posts come from Google Business Profile, for the project's own listings only; Google has no API for other businesses' posts.",
  get_domain_overview: () => NO_SOURCE,
  get_domain_keyword_suggestions: () => NO_SOURCE,
  get_ranked_keywords: () => NO_SOURCE,
  get_backlinks_overview: (s) =>
    s.dataforseoBacklinks ? BACKLINKS : NO_SOURCE,
  get_backlinks_profile: (s) => (s.dataforseoBacklinks ? BACKLINKS : NO_SOURCE),
};

// A credit sentence ends at the first period followed by a space or the end,
// so "~2.5" and "(~95 at 500)" stay inside it.
const CREDIT_SENTENCE = /Charges credits.*?\.(?=\s|$)/;

/**
 * A tool's description as this server runs it: unchanged without stand-ins,
 * else with its credit sentence replaced by the provider that serves it, or
 * by a plain "no source" when nothing does.
 */
export function describeForStandIns(
  name: string,
  description: string | undefined,
  standIns: McpStandIns | undefined,
): string | undefined {
  const note = standIns ? COST_NOTES[name] : undefined;
  if (!note || !standIns || !description) return description;
  return description.replace(CREDIT_SENTENCE, note(standIns));
}
