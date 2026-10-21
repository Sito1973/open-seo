import { sortBy } from "remeda";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { GoogleAdsGrantRepository } from "@/server/features/google-ads/GoogleAdsGrantRepository";
import { getGoogleAccessToken } from "@/server/features/google/googleOAuth";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import type {
  AdsKeywordItem,
  fetchAdsKeywordIdeas,
  fetchAdsSearchVolume,
} from "@/server/lib/dataforseo/google-ads";
import { AppError } from "@/server/lib/errors";
import { googleAdsApiError } from "@/server/lib/googleAdsErrors";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import {
  getKeywordPlannerConfig,
  type KeywordPlannerConfig,
} from "@/server/lib/keywordPlannerConfig";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { GOOGLE_ADS_OAUTH_PROVIDER_ID } from "@/shared/google-ads";
import {
  formatLocationLabel,
  getIsoCountryCode,
} from "@/shared/keyword-locations";

// The Google Ads API Keyword Planner: search volume and keyword ideas on
// self-hosted installs without DataForSEO. It is the data DataForSEO's
// keywords_data/google_ads endpoints resell, so results come back in the same
// AdsKeywordItem shape and reuse the Google Ads mapping. Read-only: the client
// calls KeywordPlanIdeaService and a geo target lookup, never a mutate.
// Developer tokens were sunset on September 9, 2026: the access level belongs
// to the Cloud project that owns the OAuth client, so no developer-token
// header is sent. The host is fixed, so no SSRF screening applies.
const API_BASE = "https://googleads.googleapis.com/v26";
const REQUEST_TIMEOUT_MS = 30_000;
// KeywordPlanIdeaService is "limited to 1 request per second per CID".
const MIN_REQUEST_INTERVAL_MS = 1_000;
// Keyword Planner refreshes its numbers monthly, so an answer is cached under
// the current month and reused until the month changes.
const CACHE_TTL_SECONDS = 32 * 24 * 60 * 60;
// One page of ideas. DataForSEO's keywords_for_keywords returns ideas sorted
// by volume and cut to the limit; the top of one 1,000-idea page does the same.
const IDEAS_PAGE_SIZE = 1_000;

// Google Ads language criterion IDs from the official languagecodes.csv, keyed
// by the codes OpenSEO projects use. A language Google Ads lacks is left out
// of the request, which Google reads as every language.
const LANGUAGE_CRITERIA: Record<string, number> = {
  ar: 1019,
  bg: 1020,
  bn: 1056,
  ca: 1038,
  cs: 1021,
  da: 1009,
  de: 1001,
  el: 1022,
  en: 1000,
  es: 1003,
  et: 1043,
  fa: 1064,
  fi: 1011,
  fr: 1002,
  gu: 1072,
  he: 1027,
  hi: 1023,
  hr: 1039,
  hu: 1024,
  id: 1025,
  is: 1026,
  it: 1004,
  ja: 1005,
  kn: 1086,
  ko: 1012,
  lt: 1029,
  lv: 1028,
  ml: 1098,
  mr: 1101,
  ms: 1102,
  nb: 1013,
  nl: 1010,
  no: 1013,
  pa: 1110,
  pl: 1030,
  pt: 1014,
  ro: 1032,
  ru: 1031,
  sk: 1033,
  sl: 1034,
  sr: 1035,
  sv: 1015,
  ta: 1130,
  te: 1131,
  th: 1044,
  tl: 1042,
  tr: 1037,
  uk: 1036,
  ur: 1041,
  vi: 1040,
  "zh-CN": 1017,
  "zh-TW": 1018,
};

const MONTHS = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER",
];

const COMPETITION_LEVELS = new Set(["LOW", "MEDIUM", "HIGH"]);

// JSON carries int64 fields as strings.
const int64 = z.coerce.number();

const metricsSchema = z
  .object({
    avgMonthlySearches: int64.optional(),
    competition: z.string().optional(),
    competitionIndex: int64.optional(),
    monthlySearchVolumes: z
      .array(
        z.object({
          year: int64,
          month: z.string(),
          monthlySearches: int64.optional(),
        }),
      )
      .optional(),
  })
  .optional();

const historicalMetricsSchema = z.object({
  results: z
    .array(
      z.object({
        text: z.string(),
        closeVariants: z.array(z.string()).optional(),
        keywordMetrics: metricsSchema,
      }),
    )
    .default([]),
});

const keywordIdeasSchema = z.object({
  results: z
    .array(z.object({ text: z.string(), keywordIdeaMetrics: metricsSchema }))
    .default([]),
});

const geoTargetSearchSchema = z.object({
  results: z
    .array(
      z.object({
        geoTargetConstant: z.object({ id: int64, countryCode: z.string() }),
      }),
    )
    .default([]),
});

type SearchVolumeInput = Parameters<typeof fetchAdsSearchVolume>[0] & {
  creditFeature?: CreditFeature;
};
type KeywordIdeasInput = Parameters<typeof fetchAdsKeywordIdeas>[0] & {
  creditFeature?: CreditFeature;
};

/**
 * The two Google Ads keyword calls, shaped like DataForSEO's client so either
 * one serves the Google Ads paths of keyword research.
 */
export type AdsKeywordClient = {
  keywords: {
    adsSearchVolume: (input: SearchVolumeInput) => Promise<AdsKeywordItem[]>;
    adsIdeas: (input: KeywordIdeasInput) => Promise<AdsKeywordItem[]>;
  };
};

/**
 * Keyword Planner calls made with this user's Google Ads grant, or null when
 * the Keyword Planner does not stand in for DataForSEO on this install.
 */
export async function getKeywordPlannerClient(
  userId: string,
): Promise<AdsKeywordClient | null> {
  const config = await getKeywordPlannerConfig();
  if (!config) return null;

  const call = async (path: string, body: object): Promise<unknown> => {
    // Keyed by user so one user's grant never answers for another.
    const key = await buildCacheKey("google-ads:keyword-planner", {
      userId,
      month: new Date().toISOString().slice(0, 7),
      path,
      body,
    });
    const cached = await getCached(key);
    if (cached !== null) return cached;
    const payload = await post(config, userId, path, body);
    await setCached(key, payload, CACHE_TTL_SECONDS);
    return payload;
  };

  const targeting = async (input: {
    locationCode: number;
    languageCode: string;
    locationName?: string;
  }) => {
    const geoTarget = input.locationName
      ? await resolveGeoTarget(
          call,
          config,
          input.locationCode,
          input.locationName,
        )
      : // DataForSEO location codes are Google Ads geo target IDs.
        input.locationCode;
    const language = LANGUAGE_CRITERIA[input.languageCode];
    return {
      geoTargetConstants: [`geoTargetConstants/${geoTarget}`],
      ...(language ? { language: `languageConstants/${language}` } : {}),
      keywordPlanNetwork: "GOOGLE_SEARCH",
      includeAdultKeywords: false,
    };
  };

  return {
    keywords: {
      adsSearchVolume: async (input) => {
        const keywords = [...new Set(input.keywords)];
        const payload = await call(
          `customers/${config.customerId}:generateKeywordHistoricalMetrics`,
          { keywords, ...(await targeting(input)) },
        );
        return historicalMetricItems(
          keywords,
          historicalMetricsSchema.parse(payload).results,
        );
      },
      adsIdeas: async (input) => {
        const payload = await call(
          `customers/${config.customerId}:generateKeywordIdeas`,
          {
            keywordSeed: { keywords: [input.keyword] },
            pageSize: IDEAS_PAGE_SIZE,
            ...(await targeting(input)),
          },
        );
        const ideas = keywordIdeasSchema
          .parse(payload)
          .results.map((result) =>
            toAdsKeywordItem(result.text, result.keywordIdeaMetrics),
          );
        return sortBy(ideas, [
          (idea) => idea.search_volume ?? -1,
          "desc",
        ]).slice(0, input.limit);
      },
    },
  };
}

/**
 * The client for keyword metrics: the Keyword Planner on a self-hosted install
 * that uses it, otherwise DataForSEO.
 */
export async function getKeywordDataClient(billing: BillingCustomerContext) {
  return (
    (await getKeywordPlannerClient(billing.userId)) ??
    createDataforseoClient(billing)
  );
}

/**
 * Google merges close variants ("hamburguesa" / "hamburguesas") into one
 * result. Each requested keyword among them gets the shared metrics, as the
 * research tools already describe for Google Ads data.
 */
function historicalMetricItems(
  keywords: string[],
  results: z.infer<typeof historicalMetricsSchema>["results"],
): AdsKeywordItem[] {
  const requested = new Map(
    keywords.map((keyword) => [keyword.toLowerCase(), keyword]),
  );
  const items: AdsKeywordItem[] = [];
  for (const result of results) {
    const matches = [result.text, ...(result.closeVariants ?? [])].flatMap(
      (text) => {
        const keyword = requested.get(text.toLowerCase());
        if (!keyword) return [];
        requested.delete(text.toLowerCase());
        return [keyword];
      },
    );
    for (const keyword of matches.length > 0 ? matches : [result.text]) {
      items.push(toAdsKeywordItem(keyword, result.keywordMetrics));
    }
  }
  return items;
}

function toAdsKeywordItem(
  keyword: string,
  metrics: z.infer<typeof metricsSchema>,
): AdsKeywordItem {
  return {
    keyword,
    search_volume: metrics?.avgMonthlySearches ?? null,
    cpc: null,
    competition:
      metrics?.competition && COMPETITION_LEVELS.has(metrics.competition)
        ? metrics.competition
        : null,
    competition_index: metrics?.competitionIndex ?? null,
    monthly_searches: (metrics?.monthlySearchVolumes ?? []).flatMap((entry) => {
      const month = MONTHS.indexOf(entry.month) + 1;
      return month > 0
        ? [
            {
              year: entry.year,
              month,
              search_volume: entry.monthlySearches ?? null,
            },
          ]
        : [];
    }),
  };
}

/**
 * The geo target ID of a city, county or region, by the canonical name
 * DataForSEO and Google Ads share ("Pereira,Risaralda,Colombia").
 */
async function resolveGeoTarget(
  call: (path: string, body: object) => Promise<unknown>,
  config: KeywordPlannerConfig,
  locationCode: number,
  locationName: string,
): Promise<number> {
  const country = getIsoCountryCode(locationCode).toUpperCase();
  const unknown = new AppError(
    "UNKNOWN_LOCATION",
    `"${formatLocationLabel(locationName)}" is not a Google Ads location in ${country}. Pass its full Google Ads name, such as "Pereira,Risaralda,Colombia".`,
  );
  // A double-quoted GAQL string cannot hold these unescaped; no canonical
  // name has them.
  if (/["\\\r\n]/.test(locationName)) throw unknown;
  const payload = await call(
    `customers/${config.customerId}/googleAds:search`,
    {
      query: `SELECT geo_target_constant.id, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.canonical_name = "${locationName}" AND geo_target_constant.status = 'ENABLED'`,
    },
  );
  const match = geoTargetSearchSchema
    .parse(payload)
    .results.find((row) => row.geoTargetConstant.countryCode === country);
  if (!match) throw unknown;
  return match.geoTargetConstant.id;
}

async function accessToken(userId: string): Promise<string> {
  const grant = await GoogleAdsGrantRepository.getLatestGrant(userId);
  if (!grant) {
    throw new AppError(
      "GOOGLE_ADS_NOT_CONNECTED",
      "Keyword data on this server comes from the Google Ads Keyword Planner, and you have not connected Google Ads yet. Connect it in OpenSEO under a project's Settings → Integrations, then try again.",
    );
  }
  try {
    return await getGoogleAccessToken({
      userId,
      providerId: GOOGLE_ADS_OAUTH_PROVIDER_ID,
      accountId: grant.accountId,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    console.warn("google_ads.token_refresh_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new AppError(
      "GOOGLE_ADS_NOT_CONNECTED",
      "OpenSEO could not refresh the saved Google Ads connection; it may have expired or been revoked. Reconnect Google Ads in OpenSEO under a project's Settings → Integrations, then try again.",
    );
  }
}

// Spaces requests at least a second apart in this process, so parallel seeds
// queue instead of tripping Google's per-account rate limit.
let nextRequestAt = 0;

async function waitForRequestSlot() {
  const now = Date.now();
  const at = Math.max(now, nextRequestAt);
  nextRequestAt = at + MIN_REQUEST_INTERVAL_MS;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

async function post(
  config: KeywordPlannerConfig,
  userId: string,
  path: string,
  body: object,
): Promise<unknown> {
  await waitForRequestSlot();
  // After the wait: a queued request can sit long enough for a token fetched
  // earlier to expire.
  const token = await accessToken(userId);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(config.loginCustomerId
          ? { "login-customer-id": config.loginCustomerId }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("google_ads.request_failed", { path, error });
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "The Google Ads API did not answer. Try again in a moment.",
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) return payload;
  throw googleAdsApiError(response.status, payload, config);
}
