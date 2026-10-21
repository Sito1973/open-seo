import { GooglePlacesUsageRepository } from "@/server/features/google-places/repositories/GooglePlacesUsageRepository";
import { hasGoogleOAuthConfig } from "@/server/features/google/oauth-config";
import { MONTHLY_LIVE_ESTIMATES } from "@/server/features/serp/services/difficultyEstimate";
import {
  getBrightDataBudget,
  getBrightDataSerp,
} from "@/server/lib/brightDataSerp";
import {
  AUTOCOMPLETE_MONTHLY_BUDGET,
  googleAutocompletePausedUntil,
} from "@/server/lib/googleAutocomplete";
import { getPlacesBudgets } from "@/server/lib/googlePlaces";
import { getKeywordPlannerConfig } from "@/server/lib/keywordPlannerConfig";
import { OPEN_PAGERANK_MONTHLY_DOMAINS } from "@/server/lib/openPageRank";
import {
  getDataforseoKey,
  getGoogleFallbackKey,
  getOptionalEnvValue,
  usesGoogleFallbacks,
} from "@/server/lib/runtime-env";
import {
  SERPAPI_MONTHLY_BUDGET,
  getSerpApiKey,
  serpApiSearchesUsed,
} from "@/server/lib/serpApiAiMode";
import {
  resolveDataSections,
  type DataBudget,
  type DataSourceProviders,
  type DataSourcesStatus,
} from "@/shared/data-sources";
import { parseBacklinksMonthlyRequests } from "@/shared/selfhost-checks";

const UTC_RESET = "the 1st, UTC";

/**
 * The stand-in providers this server has set up, from its environment only.
 * Null unless stand-ins apply (usesGoogleFallbacks): hosted installs and
 * installs that use DataForSEO for every feature have DataForSEO behind each
 * section and keep their behavior.
 */
export async function getDataSourceProviders(): Promise<DataSourceProviders | null> {
  if (!(await usesGoogleFallbacks())) return null;
  const [
    brightData,
    places,
    keywordPlanner,
    serpApi,
    openPageRank,
    pageSpeed,
    googleOAuth,
    model,
    ahrefs,
    backlinksKey,
  ] = await Promise.all([
    getBrightDataSerp(),
    getGoogleFallbackKey("GOOGLE_PLACES_API_KEY"),
    getKeywordPlannerConfig(),
    getSerpApiKey(),
    getGoogleFallbackKey("OPENPAGERANK_API_KEY"),
    getGoogleFallbackKey("GOOGLE_PAGESPEED_API_KEY"),
    hasGoogleOAuthConfig(),
    getOptionalEnvValue("OPENROUTER_API_KEY"),
    getOptionalEnvValue("AHREFS_API_KEY"),
    getDataforseoKey("backlinks"),
  ]);
  return {
    brightData: brightData !== null,
    places: places !== null,
    keywordPlanner: keywordPlanner !== null,
    serpApi: serpApi !== null,
    openPageRank: openPageRank !== null,
    pageSpeed: pageSpeed !== null,
    googleOAuth,
    model: Boolean(model),
    ahrefs: Boolean(ahrefs),
    dataforseoBacklinks: backlinksKey !== null,
  };
}

function usedThisMonthUtc(
  sku:
    | "difficulty_estimate"
    | "google_autocomplete"
    | "open_pagerank"
    | "dataforseo_backlinks",
) {
  return GooglePlacesUsageRepository.usedCalls({
    month: new Date().toISOString().slice(0, 7),
    sku,
  });
}

/** The monthly budgets of the providers this server has set up. */
async function getBudgets(
  providers: DataSourceProviders,
): Promise<DataBudget[]> {
  const budgets: DataBudget[] = [];
  if (providers.brightData) {
    const [bright, estimates] = await Promise.all([
      getBrightDataBudget(),
      usedThisMonthUtc("difficulty_estimate"),
    ]);
    budgets.push(
      {
        label: "Bright Data SERP requests",
        used: bright.usedThisMonth,
        limit: bright.monthlyBudget,
        resets: UTC_RESET,
        note: "Shared by rank tracking, the SERP tools, Google AI Overviews, Prompt Research, related keyword searches and difficulty estimates.",
      },
      {
        label: "Live difficulty estimates",
        used: estimates,
        limit: MONTHLY_LIVE_ESTIMATES,
        resets: UTC_RESET,
        note: "Part of the Bright Data requests above.",
      },
    );
  }
  if (providers.serpApi) {
    budgets.push({
      label: "SerpApi searches (Google AI Mode)",
      used: await serpApiSearchesUsed(),
      limit: SERPAPI_MONTHLY_BUDGET,
      resets: UTC_RESET,
      note: "SerpApi's own plan month starts on your signup date.",
    });
  }
  if (providers.places) {
    for (const places of await getPlacesBudgets()) {
      budgets.push({
        label: `Google Places ${places.label}`,
        used: places.usedThisMonth,
        limit: places.limit,
        resets: "the 1st, Pacific time",
        note: null,
      });
    }
  }
  const [autocomplete, pausedUntil] = await Promise.all([
    usedThisMonthUtc("google_autocomplete"),
    googleAutocompletePausedUntil(),
  ]);
  budgets.push({
    label: "Google autocomplete lookups",
    used: autocomplete,
    limit: AUTOCOMPLETE_MONTHLY_BUDGET,
    resets: UTC_RESET,
    note: pausedUntil
      ? `Paused until ${pausedUntil.slice(0, 16).replace("T", " ")} UTC, because Google refused a lookup.`
      : null,
  });
  if (providers.openPageRank) {
    budgets.push({
      label: "Open PageRank domains",
      used: await usedThisMonthUtc("open_pagerank"),
      limit: OPEN_PAGERANK_MONTHLY_DOMAINS,
      resets: UTC_RESET,
      note: null,
    });
  }
  const backlinksLimit = parseBacklinksMonthlyRequests(
    await getOptionalEnvValue("DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS"),
  );
  if (providers.dataforseoBacklinks && backlinksLimit !== null) {
    budgets.push({
      label: "DataForSEO backlinks requests",
      used: await usedThisMonthUtc("dataforseo_backlinks"),
      limit: backlinksLimit,
      resets: UTC_RESET,
      note: "DataForSEO bills each request.",
    });
  }
  return budgets;
}

/**
 * What serves each former DataForSEO section on this server, with the monthly
 * budgets this server enforces and their use this month. Null on hosted
 * installs and installs that use DataForSEO for every feature.
 */
export async function getDataSources(): Promise<DataSourcesStatus | null> {
  const providers = await getDataSourceProviders();
  if (!providers) return null;
  return {
    sections: resolveDataSections(providers),
    budgets: await getBudgets(providers),
  };
}
