import { GbpService } from "@/server/features/gbp/services/GbpService";
import { GscService } from "@/server/features/gsc/services/GscService";
import { searchGoogleCandidates } from "@/server/features/serp/services/googleCandidates";
import { getBrightDataSerp } from "@/server/lib/brightDataSerp";
import { fetchAdsSearchVolumeForKeywords } from "@/server/lib/dataforseo/keyword-metrics";
import { AppError } from "@/server/lib/errors";
import {
  GbpApiError,
  GbpNotConnectedError,
  GbpTokenError,
} from "@/server/lib/gbpErrors";
import { getKeywordPlannerClient } from "@/server/lib/googleAdsKeywordPlanner";
import { fetchGoogleAutocomplete } from "@/server/lib/googleAutocomplete";
import {
  GscApiError,
  GscNotConnectedError,
  GscTokenError,
} from "@/server/lib/gscErrors";
import type {
  AiPromptCandidateOrigin,
  AiPromptCandidateVolume,
} from "@/shared/ai-visibility";

// Where Prompt Research finds prompt candidates on a self-hosted server
// without DataForSEO: Google's results page through Bright Data, Google
// autocomplete, and the project's own Search Console and Business Profile.

const SEARCH_CONSOLE_ROWS = 1_000;
const BUSINESS_PROFILE_KEYWORDS = 500;

// How Colombian Spanish asks for a recommendation, unaccented as people type
// it. Each is one autocomplete lookup, plus "<keyword> en <city>".
const SPANISH_PREFIXES = [
  "donde comer",
  "cual es el mejor",
  "que",
  "recomienden",
];

// Questions and asks for a recommendation in Search Console queries, as RE2
// for its includingRegex filter. RE2's \b is ASCII-only and fails next to an
// accented letter, so a word ends at a space or the end instead.
const QUESTION_PATTERN =
  "^(¿\\s*)?(que|qué|cual|cuál|cuales|cuáles|donde|dónde|como|cómo|cuando|cuándo|cuanto|cuánto|cuantos|cuántos|quien|quién|por que|por qué|porque|mejor|mejores|recomienda|recomiendan|recomienden|what|where|which|how|who|why|best)(\\s|$)";

export type PromptCandidate = {
  text: string;
  origin: AiPromptCandidateOrigin;
  volume: AiPromptCandidateVolume | null;
  peopleAlsoAsk?: {
    answer: string | null;
    url: string | null;
    domain: string | null;
  };
  promptId?: string;
};

type Market = {
  locationCode: number;
  languageCode: string;
  locationName: string | null;
};

/**
 * Why a source left no candidates, for the result's notes. Only a missing
 * connection or a provider's answer degrades; anything else is a bug.
 */
function problem(error: unknown): string {
  if (error instanceof GscNotConnectedError)
    return "Search Console is not connected to this project (Settings → Integrations)";
  if (error instanceof GbpNotConnectedError)
    return "Google Business Profile is not connected to this project (Settings → Integrations)";
  if (error instanceof GscTokenError || error instanceof GbpTokenError)
    return "reconnect the Google account under Settings → Integrations";
  if (
    error instanceof AppError ||
    error instanceof GscApiError ||
    error instanceof GbpApiError
  )
    return error.message.replace(/\.$/, "");
  throw error;
}

async function settle(
  what: string,
  work: () => Promise<PromptCandidate[]>,
): Promise<{ items: PromptCandidate[]; note: string | null }> {
  try {
    return { items: await work(), note: null };
  } catch (error) {
    return { items: [], note: `${what}: ${problem(error)}.` };
  }
}

/**
 * People Also Ask and related searches on the keyword's first Google page,
 * near the project's tracked city: one Bright Data request from the monthly
 * budget, saved to the organization's SERP store, through the cache every
 * Google candidate search shares.
 */
async function googlePage(input: {
  keyword: string;
  market: Market;
  device: "desktop" | "mobile";
  organizationId: string;
}): Promise<PromptCandidate[]> {
  const config = await getBrightDataSerp();
  if (!config)
    throw new AppError(
      "VALIDATION_ERROR",
      "Bright Data is not set up on this server (BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE)",
    );
  const page = await searchGoogleCandidates(config, {
    query: input.keyword,
    market: input.market,
    device: input.device,
    organizationId: input.organizationId,
  });
  return [
    ...page.peopleAlsoAsk.map(
      ({ question, ...answer }): PromptCandidate => ({
        text: question,
        origin: "people_also_ask",
        volume: null,
        peopleAlsoAsk: answer,
      }),
    ),
    ...page.relatedSearches.map(
      (text): PromptCandidate => ({
        text,
        origin: "related_search",
        volume: null,
      }),
    ),
  ];
}

/** Google autocomplete for the keyword's question forms and its city. */
async function autocomplete(
  keyword: string,
  market: Market,
  city: string | null,
): Promise<{ items: PromptCandidate[]; note: string | null }> {
  const spanish = market.languageCode === "es";
  const queries = [
    ...(spanish
      ? SPANISH_PREFIXES.map((prefix) => `${prefix} ${keyword}`)
      : [keyword]),
    ...(city && !keyword.includes(city)
      ? [spanish ? `${keyword} en ${city}` : `${keyword} ${city}`]
      : []),
  ];
  const found = await fetchGoogleAutocomplete({
    seed: keyword,
    locationCode: market.locationCode,
    languageCode: market.languageCode,
    queries,
  });
  return {
    items: found.suggestions.map((text) => ({
      text,
      origin: "autocomplete",
      volume: null,
    })),
    note:
      found.unavailable && `Some autocomplete is missing: ${found.unavailable}`,
  };
}

/** The site's own Google questions over the last 3 months, with impressions. */
async function searchConsoleQuestions(
  projectId: string,
): Promise<PromptCandidate[]> {
  const { rows } = await GscService.getPerformance({
    projectId,
    dimensions: ["query"],
    dateRange: "last_3_months",
    filters: [
      {
        dimension: "query",
        operator: "includingRegex",
        expression: QUESTION_PATTERN,
      },
    ],
    rowLimit: SEARCH_CONSOLE_ROWS,
    type: "web",
  });
  return rows.flatMap((row): PromptCandidate[] =>
    row.keys?.[0]
      ? [
          {
            text: row.keys[0],
            origin: "search_console",
            volume: {
              source: "search_console",
              value: row.impressions,
              below: false,
            },
          },
        ]
      : [],
  );
}

/** What people searched before the listing showed, last 3 complete months. */
async function businessProfileSearches(project: {
  id: string;
  domain: string | null;
}): Promise<PromptCandidate[]> {
  const result = await GbpService.getSearchKeywords({
    projectId: project.id,
    projectDomain: project.domain,
    limit: BUSINESS_PROFILE_KEYWORDS,
  }).catch((error: unknown) => {
    // The account has several listings and none has this site's domain.
    if (error instanceof AppError && error.code === "VALIDATION_ERROR")
      throw new AppError(
        "VALIDATION_ERROR",
        "no listing of the connected account has this project's website",
      );
    throw error;
  });
  return result.keywords.map(
    ({ keyword, impressions, impressionsBelow }): PromptCandidate => {
      const value = impressions ?? impressionsBelow;
      return {
        text: keyword,
        origin: "business_profile",
        volume:
          value == null
            ? null
            : { source: "business_profile", value, below: impressions == null },
      };
    },
  );
}

/**
 * Every source's candidates for a keyword, in a fixed order: the Google page
 * first, then searches people typed (autocomplete, Search Console, Business
 * Profile). A source that is not set up or did not answer leaves a note.
 */
export async function loadPromptCandidates(input: {
  keyword: string;
  market: Market;
  device: "desktop" | "mobile";
  city: string | null;
  project: { id: string; domain: string | null };
  organizationId: string;
}) {
  const [serp, suggestions, searchConsole, businessProfile] = await Promise.all(
    [
      settle("No People Also Ask or related searches", () => googlePage(input)),
      autocomplete(input.keyword, input.market, input.city),
      settle("No Search Console questions", () =>
        searchConsoleQuestions(input.project.id),
      ),
      settle("No Business Profile searches", () =>
        businessProfileSearches(input.project),
      ),
    ],
  );
  return {
    fromPage: serp.items,
    searched: [
      ...suggestions.items,
      ...searchConsole.items,
      ...businessProfile.items,
    ],
    notes: [serp, suggestions, searchConsole, businessProfile].flatMap(
      ({ note }) => note ?? [],
    ),
  };
}

/**
 * Keyword Planner average monthly searches for these keyword texts, in one
 * request, keyed by lowercase text. None when the Planner does not stand in
 * on this server; a note when it cannot answer yet.
 */
export async function plannerVolumes(
  texts: string[],
  market: Market,
  billing: { userId: string; projectId: string },
): Promise<{ volumes: Map<string, number>; note: string | null }> {
  const planner = await getKeywordPlannerClient(
    billing.userId,
    billing.projectId,
  );
  if (!planner || !texts.length) return { volumes: new Map(), note: null };
  try {
    const items = await fetchAdsSearchVolumeForKeywords(planner, {
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      keywords: texts,
    });
    return {
      volumes: new Map(
        items.flatMap((item) =>
          item.keyword && item.search_volume != null
            ? [[item.keyword.toLowerCase(), item.search_volume]]
            : [],
        ),
      ),
      note: null,
    };
  } catch (error) {
    const reason =
      error instanceof AppError && error.code === "GOOGLE_ADS_ACCESS_PENDING"
        ? "Google has not approved Basic access to the Keyword Planner for this server yet"
        : problem(error);
    return {
      volumes: new Map(),
      note: `No Keyword Planner volumes: ${reason}.`,
    };
  }
}
