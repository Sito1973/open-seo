// What serves each section that DataForSEO used to serve, on a self-hosted
// install that does not use DataForSEO for features other than backlinks
// (usesGoogleFallbacks). Hosted installs and installs with DataForSEO for
// every feature have no such map: DataForSEO serves them all. One map feeds
// the /help/data-sources page, the sidebar, the shared "no source" empty
// state, the MCP instructions and tool descriptions, and whoami, so they can
// never disagree. When a later phase adds a stand-in, it changes the status
// of its section here.

/**
 * ready: a stand-in serves the section. partial: it serves part of it, such
 * as your own sites only. needs_setup: a stand-in exists but this server has
 * not set it up. unavailable: no stand-in exists.
 */
export type DataSourceState =
  | "ready"
  | "partial"
  | "needs_setup"
  | "unavailable";

/** The stand-in providers this server has set up, from its environment. */
export type DataSourceProviders = {
  /** BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE. */
  brightData: boolean;
  /** GOOGLE_PLACES_API_KEY. */
  places: boolean;
  /** The Google Ads client and customer ID of the Keyword Planner. */
  keywordPlanner: boolean;
  /** SERPAPI_API_KEY. */
  serpApi: boolean;
  /** OPENPAGERANK_API_KEY. */
  openPageRank: boolean;
  /** GOOGLE_PAGESPEED_API_KEY. */
  pageSpeed: boolean;
  /** A Google OAuth client, so Search Console, Analytics and Business Profile can connect. */
  googleOAuth: boolean;
  /** OPENROUTER_API_KEY, for the drafts the app writes with a model. */
  model: boolean;
  /** AHREFS_API_KEY. */
  ahrefs: boolean;
  /** DATAFORSEO_API_KEY with DATAFORSEO_SCOPE=backlinks. */
  dataforseoBacklinks: boolean;
};

type SectionStatus = {
  state: DataSourceState;
  source: string;
  detail: string;
};

const BRIGHT_DATA_SETUP = "Set BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE.";

const SECTIONS = [
  {
    id: "keyword_research",
    label: "Keyword research",
    path: "/p/$projectId/keywords",
    tools: ["research_keywords", "get_keyword_metrics"],
    status: (p: DataSourceProviders): SectionStatus =>
      p.keywordPlanner
        ? {
            state: "ready",
            source: "Google Ads Keyword Planner",
            detail: `Search volume, trend, paid competition, CPC in US dollars and Spanish search intent, once Google Ads is connected in a project's Settings → Integrations. Until Google grants Basic API access, keyword research lists the project's Search Console queries instead. Phrase match adds Google autocomplete${p.brightData ? ", and related searches come from Bright Data" : ""}.`,
          }
        : {
            state: "needs_setup",
            source: "Google Ads Keyword Planner",
            detail:
              "Set GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and GOOGLE_ADS_CUSTOMER_ID, then connect Google Ads in a project's Settings → Integrations.",
          },
  },
  {
    id: "keyword_difficulty",
    label: "Keyword difficulty",
    path: null,
    tools: ["estimate_keyword_difficulty"],
    status: (p: DataSourceProviders): SectionStatus =>
      p.brightData
        ? {
            state: "partial",
            source: p.openPageRank
              ? "OpenSEO estimate from Bright Data and Open PageRank"
              : "OpenSEO estimate from Bright Data",
            detail: `Estimated from each keyword's first Google page: the local pack's review counts${p.openPageRank ? " and the top 10's Open PageRank authority" : "; set OPENPAGERANK_API_KEY to add the top 10's authority"}. Tracked keywords get one after each rank check; other keywords cost one Bright Data request each, within their own monthly budget.`,
          }
        : {
            state: "needs_setup",
            source: "OpenSEO estimate from Bright Data",
            detail: BRIGHT_DATA_SETUP,
          },
  },
  {
    id: "rank_tracking",
    label: "Rank tracking",
    path: "/p/$projectId/rank-tracking",
    tools: ["run_rank_tracker"],
    status: (p: DataSourceProviders): SectionStatus =>
      p.brightData
        ? {
            state: "ready",
            source: "Bright Data live Google SERP",
            detail:
              "One request per 10 results of depth for each keyword and device, stopping at the page where the domain appears. Scheduled checks reuse a recently saved first page of the same search.",
          }
        : {
            state: "needs_setup",
            source: "Bright Data live Google SERP",
            detail: BRIGHT_DATA_SETUP,
          },
  },
  {
    id: "serp",
    label: "Google results and SERP competitors",
    path: null,
    tools: ["get_serp_results", "find_serp_competitors"],
    status: (p: DataSourceProviders): SectionStatus =>
      p.brightData
        ? {
            state: "ready",
            source: "Bright Data live Google SERP",
            detail:
              "get_serp_results, find_serp_competitors, the SERP Analysis card in keyword research and the competitor search of project setup. Every first page is saved, and find_serp_competitors reads recently saved pages before it searches.",
          }
        : {
            state: "needs_setup",
            source: "Bright Data live Google SERP",
            detail: BRIGHT_DATA_SETUP,
          },
  },
  {
    id: "domain",
    label: "Domain Overview",
    path: "/p/$projectId/domain",
    tools: [
      "get_domain_overview",
      "get_domain_keyword_suggestions",
      "get_ranked_keywords",
    ],
    status: (p: DataSourceProviders): SectionStatus =>
      p.googleOAuth
        ? {
            state: "partial",
            source: "Google Search Console",
            detail:
              "Your own sites only, from the Search Console properties connected in the organization's projects: their real recent clicks and queries. Competitors' domains have no source.",
          }
        : {
            state: "needs_setup",
            source: "Google Search Console",
            detail:
              "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and BETTER_AUTH_SECRET, then connect Search Console in a project. Competitors' domains have no source.",
          },
  },
  {
    id: "backlinks",
    label: "Backlinks",
    path: "/p/$projectId/backlinks",
    tools: ["get_backlinks_overview", "get_backlinks_profile"],
    status: (p: DataSourceProviders): SectionStatus =>
      p.dataforseoBacklinks
        ? {
            state: "ready",
            source: "DataForSEO Backlinks API",
            detail: `DataForSEO bills each request, under this server's monthly request budget (DATAFORSEO_SCOPE=backlinks).${p.ahrefs ? " Ahrefs fills the Ahrefs DR column." : " Set AHREFS_API_KEY for the Ahrefs DR column."}`,
          }
        : {
            state: "unavailable",
            source: "None",
            detail:
              "No free source lists backlinks. A DataForSEO key with DATAFORSEO_SCOPE=backlinks serves them alone, under a monthly request budget.",
          },
  },
  {
    id: "local",
    label: "Local SEO and Google Maps",
    path: null,
    tools: [
      "search_local_businesses",
      "get_local_serp_results",
      "get_local_rank_grid",
      "get_place_details",
    ],
    status: (p: DataSourceProviders): SectionStatus =>
      p.places
        ? {
            state: "ready",
            source: p.googleOAuth
              ? "Google Places and Google Business Profile"
              : "Google Places",
            detail: `Maps results, the rank grid and competitors' listings with up to 5 reviews, under Google's free monthly allowance.${p.googleOAuth ? " Your own listings come from Business Profile once it is connected in a project." : ""} Google retired Business Profile Q&A.`,
          }
        : p.googleOAuth
          ? {
              state: "partial",
              source: "Google Business Profile",
              detail:
                "Your own listings only, once Business Profile is connected in a project. Set GOOGLE_PLACES_API_KEY for Maps results, the rank grid and competitors.",
            }
          : {
              state: "needs_setup",
              source: "Google Places",
              detail: "Set GOOGLE_PLACES_API_KEY.",
            },
  },
  {
    id: "site_audit",
    label: "Site audit",
    path: "/p/$projectId/audit",
    tools: [],
    status: (p: DataSourceProviders): SectionStatus =>
      p.pageSpeed
        ? {
            state: "ready",
            source: "OpenSEO crawler and PageSpeed Insights",
            detail:
              "Lighthouse checks run on Google's free PageSpeed Insights API.",
          }
        : {
            state: "partial",
            source: "OpenSEO crawler",
            detail:
              "The crawl runs without a key. Set GOOGLE_PAGESPEED_API_KEY for Lighthouse checks.",
          },
  },
  {
    id: "ai_tracking",
    label: "Prompt tracking",
    path: "/p/$projectId/ai-visibility",
    tools: ["run_ai_visibility_check"],
    status: (p: DataSourceProviders): SectionStatus => {
      const engines = [
        p.serpApi ? "Google AI Mode through SerpApi" : null,
        p.brightData ? "Google AI Overviews through Bright Data" : null,
      ].filter((engine) => engine !== null);
      return engines.length > 0
        ? {
            state: "partial",
            source: engines.join(" and "),
            detail:
              "ChatGPT, Perplexity, Claude and Gemini answers have no source on this server.",
          }
        : {
            state: "needs_setup",
            source: "SerpApi or Bright Data",
            detail:
              "Set SERPAPI_API_KEY for Google AI Mode, or Bright Data's keys for Google AI Overviews.",
          };
    },
  },
  {
    id: "prompt_research",
    label: "Prompt research",
    path: "/p/$projectId/ai-visibility/research",
    tools: ["research_ai_visibility_prompts"],
    status: (p: DataSourceProviders): SectionStatus => ({
      state: "partial",
      source: "Google's own questions",
      detail: `People Also Ask and related searches${p.brightData ? " from Bright Data" : " (they need Bright Data)"}, Google autocomplete, your Search Console questions and Business Profile searches, ranked by labeled impressions. There is no AI search volume, and no model rewrites them: you or your assistant do.`,
    }),
  },
  {
    id: "prompt_explorer",
    label: "Prompt Explorer",
    path: "/p/$projectId/prompt-explorer",
    tools: ["explore_prompt"],
    status: (): SectionStatus => ({
      state: "unavailable",
      source: "None",
      detail:
        "Asking ChatGPT, Claude, Gemini or Perplexity a prompt needs DataForSEO's AI answers, and this server has no stand-in for them.",
    }),
  },
  {
    id: "brand_lookup",
    label: "Brand Lookup",
    path: "/p/$projectId/brand-lookup",
    tools: [],
    status: (): SectionStatus => ({
      state: "partial",
      source: "Answers your prompt tracking collected",
      detail:
        "Mentions, Share of Voice and cited pages from recently tracked answers. There is no AI search volume.",
    }),
  },
  {
    id: "ai_drafts",
    label: "Project setup and prompt drafts",
    path: null,
    tools: [],
    status: (p: DataSourceProviders): SectionStatus =>
      p.model
        ? {
            state: "ready",
            source: "OpenRouter model",
            detail:
              "The app drafts the business overview, competitors, topics and prompts.",
          }
        : {
            state: "partial",
            source: "No AI model",
            detail: `Project setup and Generate return the website's pages${p.brightData ? " and live Google results" : ""} instead of drafts; you, or your assistant over MCP, write and save them.`,
          },
  },
  {
    id: "locations",
    label: "Locations and business categories",
    path: null,
    tools: [],
    status: (): SectionStatus => ({
      state: "ready",
      source: "Google Ads geo targets and Business Profile categories",
      detail:
        "The city picker and search_serp_locations read Google's geo targets file, which needs no key. Business categories come from Business Profile, or from the Google Places types until it is connected.",
    }),
  },
] as const;

export type DataSectionId = (typeof SECTIONS)[number]["id"];
type DataSectionPath = NonNullable<(typeof SECTIONS)[number]["path"]>;

export type DataSection = SectionStatus & {
  id: DataSectionId;
  label: string;
  /** The section's app page, when it has one. */
  path: DataSectionPath | null;
};

/** One monthly budget this server enforces, and its use this month. */
export type DataBudget = {
  label: string;
  used: number;
  limit: number;
  resets: string;
  note: string | null;
};

export type DataSourcesStatus = {
  sections: DataSection[];
  budgets: DataBudget[];
};

function resolve(
  section: (typeof SECTIONS)[number],
  providers: DataSourceProviders,
): DataSection {
  return {
    id: section.id,
    label: section.label,
    path: section.path,
    ...section.status(providers),
  };
}

export function resolveDataSections(
  providers: DataSourceProviders,
): DataSection[] {
  return SECTIONS.map((section) => resolve(section, providers));
}

/** Whether any source serves the section, fully or in part. */
export function hasDataSource(state: DataSourceState): boolean {
  return state === "ready" || state === "partial";
}

/** The section an MCP tool needs, with its status on this server. */
export function dataSectionForTool(
  tool: string,
  providers: DataSourceProviders,
): DataSection | null {
  const section = SECTIONS.find((candidate) => {
    const tools: readonly string[] = candidate.tools;
    return tools.includes(tool);
  });
  return section ? resolve(section, providers) : null;
}
