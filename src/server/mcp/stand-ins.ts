import {
  MAX_LIVE_KEYWORDS,
  SAVED_PAGE_MAX_AGE_DAYS,
} from "@/server/features/serp/services/serpCompetitors";
import {
  dataSectionForTool,
  hasDataSource,
  resolveDataSections,
  type DataSection,
  type DataSourceProviders,
} from "@/shared/data-sources";

const KEYWORD_PLANNER =
  "No credits here: keyword data comes from the Google Ads Keyword Planner through the Google Ads account connected in the project's Settings → Integrations.";

const BRIGHT_DATA_BUDGET =
  "this server's monthly Bright Data budget, shared with rank tracking";

const PLACES_BUDGET = "this server's monthly Google Places budget";

const NO_PLACES =
  "This server has no source for it: set GOOGLE_PLACES_API_KEY. Calls fail with PROVIDER_NOT_CONFIGURED.";

const SEARCH_CONSOLE =
  "No credits here: on this server it reads only the organization's own sites, from the Search Console properties connected in its projects (last 28 days); a domain no property covers returns empty rows.";

const BACKLINKS =
  "No credits here: each DataForSEO request it sends counts against this server's monthly backlinks budget (DATAFORSEO_SCOPE=backlinks).";

// What replaces each DataForSEO tool's "Charges credits…" sentence where
// stand-ins apply and the tool's section (shared/data-sources.ts) has a
// source. A tool whose section has none gets that section's "no source" note
// instead. A tool missing from both keeps a credit sentence that is false on
// such a server; the stand-in description test catches that.
const COST_NOTES: Record<string, (standIns: DataSourceProviders) => string> = {
  research_keywords: () =>
    `${KEYWORD_PLANNER} Until Google grants Basic API access, each seed lists the project's own Search Console queries instead, when Search Console is connected.`,
  get_keyword_metrics: () => KEYWORD_PLANNER,
  get_serp_results: () =>
    `No credits here: each keyword sends one Bright Data request per 10 results of depth, from ${BRIGHT_DATA_BUDGET}.`,
  find_serp_competitors: () =>
    `No credits here: a keyword whose first page this organization saved in the last ${SAVED_PAGE_MAX_AGE_DAYS} days costs nothing; each other keyword is one live Bright Data request for the top 10, at most ${MAX_LIVE_KEYWORDS} per call, from ${BRIGHT_DATA_BUDGET}.`,
  search_local_businesses: (s) =>
    s.places
      ? `No credits here: it runs on Google Places Text Search, from ${PLACES_BUDGET}.`
      : NO_PLACES,
  get_local_serp_results: (s) =>
    s.places
      ? `No credits here: it runs on Google Places Text Search (Maps results only, no Local Finder), from ${PLACES_BUDGET}.`
      : NO_PLACES,
  get_local_rank_grid: (s) =>
    s.places
      ? "No credits here: it runs on Google Places, as the last sentences describe."
      : NO_PLACES,
  get_business_profile: (s) =>
    `No credits here: the project's own listings come from Google Business Profile when it is connected to the project, and any other business from Google Places${s.places ? `, from ${PLACES_BUDGET}` : ", which needs GOOGLE_PLACES_API_KEY on this server"}.`,
  get_business_reviews: (s) =>
    `No credits here: the project's own listings' reviews come from Google Business Profile when it is connected to the project; any other business gets Google's 5 most relevant reviews from Google Places${s.places ? `, from ${PLACES_BUDGET}` : ", which needs GOOGLE_PLACES_API_KEY on this server"}.`,
  get_business_updates: () =>
    "No credits here: posts come from Google Business Profile, for the project's own listings only; Google has no API for other businesses' posts.",
  get_domain_overview: () => SEARCH_CONSOLE,
  get_domain_keyword_suggestions: () => SEARCH_CONSOLE,
  get_ranked_keywords: () => SEARCH_CONSOLE,
  get_backlinks_overview: () => BACKLINKS,
  get_backlinks_profile: () => BACKLINKS,
};

// A credit sentence ends at the first period followed by a space or the end,
// so "~2.5" and "(~95 at 500)" stay inside it.
const CREDIT_SENTENCE = /Charges credits.*?\.(?=\s|$)/;

function noSourceNote(section: DataSection): string {
  return `${section.label} has no source on this server, so calls fail with PROVIDER_NOT_CONFIGURED: ${section.detail}`;
}

/**
 * A tool's description as this server runs it: unchanged without stand-ins,
 * else with its credit sentence replaced by the provider that serves it, or
 * led by its section's "no source" note when nothing does.
 */
export function describeForStandIns(
  name: string,
  description: string | undefined,
  standIns: DataSourceProviders | undefined,
): string | undefined {
  if (!standIns || !description) return description;
  const section = dataSectionForTool(name, standIns);
  if (section && !hasDataSource(section.state)) {
    const note = noSourceNote(section);
    return CREDIT_SENTENCE.test(description)
      ? description.replace(CREDIT_SENTENCE, note)
      : `${note} ${description}`;
  }
  const note = COST_NOTES[name];
  return note
    ? description.replace(CREDIT_SENTENCE, note(standIns))
    : description;
}

/**
 * The MCP server instructions on a server with stand-ins, in place of the
 * credit guidance: nothing bills credits, and which sections have no source.
 */
export function standInInstructions(standIns: DataSourceProviders): string {
  const sections = resolveDataSections(standIns);
  const labels = (state: DataSection["state"]) =>
    sections
      .filter((section) => section.state === state)
      .map((section) => section.label)
      .join(", ");
  const none = labels("unavailable");
  const notSetUp = labels("needs_setup");
  const partial = sections.filter((section) => section.state === "partial");
  return [
    "This self-hosted OpenSEO server bills no credits: its research tools run on free Google APIs and free tiers (Bright Data, SerpApi, Google Places) under monthly budgets the server enforces, and a call past a budget fails with MONTHLY_BUDGET_EXHAUSTED. Each tool description names the provider a call uses, and whoami lists every section's source and the budgets left this month.",
    none ? `No source on this server, so skip their tools: ${none}.` : "",
    notSetUp
      ? `Not set up on this server, so their tools fail to fetch new data, while saved data (trackers, past runs) stays readable: ${notSetUp}.`
      : "",
    partial.length > 0
      ? `Only partly served: ${partial.map((section) => `${section.label} (${section.source})`).join("; ")}.`
      : "",
    standIns.dataforseoBacklinks
      ? "Backlinks tools use DataForSEO, which bills the server's owner for each request, under a monthly request cap."
      : "",
    "Ask the user before a batch that would use a large share of a monthly budget. OpenSEO cannot purchase credits or charge cards.",
  ]
    .filter(Boolean)
    .join(" ");
}
