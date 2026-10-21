import { sortBy, unique } from "remeda";
import {
  fetchBrightDataSerp,
  getBrightDataSerp,
  type BrightDataSerp,
} from "@/server/lib/brightDataSerp";
import { fetchAdsSearchVolumeForKeywords } from "@/server/lib/dataforseo/keyword-metrics";
import { AppError } from "@/server/lib/errors";
import type { AdsKeywordClient } from "@/server/lib/googleAdsKeywordPlanner";
import { fetchGoogleAutocomplete } from "@/server/lib/googleAutocomplete";
import { getKeywordPlannerConfig } from "@/server/lib/keywordPlannerConfig";
import type { CreditFeature } from "@/shared/billing-credit-features";
import type { ErrorCode } from "@/shared/error-codes";
import type { ResolvedResearchKeywordsInput } from "@/types/schemas/keywords";
import { normalizeKeyword, type EnrichedKeyword } from "./helpers";
import {
  fetchGoogleAdsResearchRows,
  mapAdsKeywordItems,
} from "./research-data";

// Keyword research's phrase match and "people also search for" modes on
// self-hosted installs where the Google Ads Keyword Planner stands in for
// DataForSEO Labs. The Planner only has ideas, so phrase match adds Google
// autocomplete, and related keywords come from the related searches and
// People Also Ask questions on Google's results page, through Bright Data.
// The Planner then measures every candidate in one request.

// One page of Planner ideas, the same request auto mode sends, so the
// Planner's monthly cache answers both.
const PLANNER_IDEAS_LIMIT = 1_000;
// The seed's first page, plus the first pages of its first three related
// searches: up to 4 Bright Data requests per new seed.
const RELATED_EXPANSIONS = 3;

type StandInResult = {
  rows: EnrichedKeyword[];
  source: "suggestions" | "related";
  usedFallback: false;
  notes?: string[];
};

type StandInContext = {
  planner: AdsKeywordClient;
  organizationId: string;
  creditFeature?: CreditFeature;
};

type Market = {
  locationCode: number;
  languageCode: string;
  creditFeature?: CreditFeature;
};

const PLANNER_PROBLEMS: Partial<Record<ErrorCode, string>> = {
  GOOGLE_ADS_ACCESS_PENDING:
    "Google has not approved Basic access to the Keyword Planner for this server yet",
  GOOGLE_ADS_NOT_CONNECTED:
    "Google Ads is not connected; connect it under a project's Settings → Integrations",
  RATE_LIMITED: "the Google Ads API quota is used up for now",
};

/** Which stand-in keyword sources this server has, for the research form. */
export async function keywordResearchSources() {
  const keywordPlanner = (await getKeywordPlannerConfig()) != null;
  return {
    keywordPlanner,
    relatedSearches: keywordPlanner && (await getBrightDataSerp()) != null,
  };
}

/**
 * Why a Keyword Planner call left the candidates without metrics. Only app
 * errors degrade; anything else is a bug and is thrown.
 */
function plannerNote(error: unknown): string {
  if (!(error instanceof AppError)) throw error;
  const problem =
    PLANNER_PROBLEMS[error.code] ?? "the Keyword Planner did not answer";
  return `No search volume, CPC or competition: ${problem}. The keywords are listed without them.`;
}

function unmeasured(keyword: string): EnrichedKeyword {
  return {
    keyword,
    searchVolume: null,
    trend: [],
    cpc: null,
    competition: null,
    keywordDifficulty: null,
    intent: "unknown",
  };
}

/**
 * Keyword Planner metrics for the candidates, in one request. A candidate it
 * does not return, or rejects as Google Ads keyword text, has none.
 */
async function measure(
  candidates: string[],
  market: Market,
  planner: AdsKeywordClient,
): Promise<{ rows: EnrichedKeyword[]; note: string | null }> {
  try {
    const items = await fetchAdsSearchVolumeForKeywords(planner, {
      ...market,
      keywords: candidates,
    });
    const measured = new Map(
      mapAdsKeywordItems(items).map((row) => [row.keyword, row]),
    );
    return {
      rows: candidates.map(
        (keyword) => measured.get(keyword) ?? unmeasured(keyword),
      ),
      note: null,
    };
  } catch (error) {
    return { rows: candidates.map(unmeasured), note: plannerNote(error) };
  }
}

function byVolume(rows: EnrichedKeyword[], limit: number) {
  return sortBy(rows, [(row) => row.searchVolume ?? -1, "desc"]).slice(
    0,
    limit,
  );
}

function result(
  source: StandInResult["source"],
  rows: EnrichedKeyword[],
  notes: Array<string | null>,
): StandInResult {
  const present = notes.filter((note) => note != null);
  return {
    rows,
    source,
    usedFallback: false,
    ...(present.length > 0 ? { notes: present } : {}),
  };
}

function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Phrase match: every seed word starts a word of the keyword, accents
 * ignored, so "hamburguesa" also matches "hamburguesas a domicilio".
 */
function phraseMatcher(seed: string) {
  const seedWords = words(seed);
  return (keyword: string) => {
    const keywordWords = words(keyword);
    return seedWords.every((seedWord) =>
      keywordWords.some((word) => word.startsWith(seedWord)),
    );
  };
}

/**
 * Phrase match: the Planner's ideas that contain the seed's words, plus Google
 * autocomplete suggestions that do, the new ones measured by the Planner.
 * While the Planner cannot answer (Basic access not approved yet), the
 * suggestions still come back, without metrics, and a note says why.
 */
async function fetchPlannerSuggestionRows(
  input: ResolvedResearchKeywordsInput,
  seedKeyword: string,
  { planner, creditFeature }: StandInContext,
): Promise<StandInResult> {
  const market = {
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    creditFeature,
  };
  const matches = phraseMatcher(seedKeyword);
  const [ideas, autocomplete] = await Promise.all([
    fetchGoogleAdsResearchRows(
      { ...market, seedKeyword, resultLimit: PLANNER_IDEAS_LIMIT },
      planner,
    ).then(
      (rows) => ({
        rows: rows.filter((row) => matches(row.keyword)),
        note: null,
      }),
      (error: unknown) => ({ rows: [], note: plannerNote(error) }),
    ),
    fetchGoogleAutocomplete({ ...market, seed: seedKeyword }),
  ]);
  const known = new Set(ideas.rows.map((row) => row.keyword));
  const candidates = unique([
    seedKeyword,
    ...autocomplete.suggestions.filter(matches),
  ]).filter((keyword) => !known.has(keyword));
  // A Planner that just failed would fail the same way again.
  const measured = ideas.note
    ? { rows: candidates.map(unmeasured), note: null }
    : await measure(candidates, market, planner);
  return result(
    "suggestions",
    byVolume([...ideas.rows, ...measured.rows], input.resultLimit),
    [ideas.note, measured.note, autocomplete.unavailable],
  );
}

/** A People Also Ask question as search text: no ¿?¡! marks. */
function questionKeyword(question: string): string {
  return normalizeKeyword(
    question.replace(/[¿?¡!]/g, " ").replace(/\s+/g, " "),
  );
}

function expansionNote(error: unknown): string {
  console.warn("keywords.research.related-expansion failed:", error);
  const reason =
    error instanceof AppError && error.code === "MONTHLY_BUDGET_EXHAUSTED"
      ? "this server's monthly Bright Data budget is used up"
      : "Bright Data did not answer";
  return `Some related searches were not expanded: ${reason}.`;
}

/**
 * People also search for: the related searches and People Also Ask questions
 * on the seed's Google results page, and on the pages of its first three
 * related searches, from Bright Data (each first page is also saved to the
 * organization's SERP store), measured by the Planner.
 */
async function fetchSerpRelatedRows(
  input: ResolvedResearchKeywordsInput,
  seedKeyword: string,
  brightData: BrightDataSerp,
  { planner, organizationId, creditFeature }: StandInContext,
): Promise<StandInResult> {
  const fetchPage = (keyword: string) =>
    fetchBrightDataSerp(brightData, {
      keyword,
      market: {
        locationCode: input.locationCode,
        languageCode: input.languageCode,
      },
      device: "desktop",
      depth: 10,
      observation: { organizationId, origin: "research" },
    });
  const first = await fetchPage(seedKeyword);
  const expansions = await Promise.allSettled(
    first.relatedSearches.slice(0, RELATED_EXPANSIONS).map(fetchPage),
  );
  const pages = [
    first,
    ...expansions.flatMap((page) =>
      page.status === "fulfilled" ? [page.value] : [],
    ),
  ];
  const failure = expansions.find((page) => page.status === "rejected");
  const candidates = unique(
    [
      seedKeyword,
      ...pages.flatMap((page) => [
        ...page.relatedSearches.map(normalizeKeyword),
        ...page.peopleAlsoAsk.map((item) => questionKeyword(item.question)),
      ]),
    ].filter(Boolean),
  );
  const measured = await measure(
    candidates,
    {
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      creditFeature,
    },
    planner,
  );
  return result("related", byVolume(measured.rows, input.resultLimit), [
    failure ? expansionNote(failure.reason) : null,
    measured.note,
  ]);
}

/**
 * Phrase match or "people also search for" on the Keyword Planner, which has
 * neither of its own. Related searches need Bright Data.
 */
export async function fetchStandInRows(
  mode: "suggestions" | "related",
  input: ResolvedResearchKeywordsInput,
  seedKeyword: string,
  context: StandInContext,
): Promise<StandInResult> {
  if (mode === "suggestions") {
    return fetchPlannerSuggestionRows(input, seedKeyword, context);
  }
  const brightData = await getBrightDataSerp();
  if (!brightData) {
    throw new AppError(
      "VALIDATION_ERROR",
      "People also search for needs Bright Data on this server: set BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE.",
    );
  }
  return fetchSerpRelatedRows(input, seedKeyword, brightData, context);
}
