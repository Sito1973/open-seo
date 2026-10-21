import { z } from "zod";
import {
  loadIntentRules,
  ruleIntent,
  type IntentRules,
} from "@/server/features/keywords/services/research/intent";
import { getCopPerUsd } from "@/server/lib/colombiaTrm";
import type { AdsKeywordItem } from "@/server/lib/dataforseo/google-ads";
import type { KeywordIntent } from "@/types/keywords";

// Turns Keyword Planner answers into the AdsKeywordItem shape DataForSEO's
// Google Ads endpoints use. Every path that stores Keyword Planner metrics
// (research, saved keyword and rank tracker refreshes, get_keyword_metrics)
// reads them through here, so CPC and intent are the same on all of them and
// a refresh never erases what research stored.

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
export const int64 = z.coerce.number();

export const metricsSchema = z
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
    // In micros of the Ads account's currency.
    averageCpcMicros: int64.optional(),
    lowTopOfPageBidMicros: int64.optional(),
    highTopOfPageBidMicros: int64.optional(),
  })
  .optional();

const customerCurrencySchema = z.object({
  results: z
    .array(z.object({ customer: z.object({ currencyCode: z.string() }) }))
    .min(1),
});

type Metrics = z.infer<typeof metricsSchema>;

/** One keyword of a Keyword Planner answer, before normalization. */
export type PlannerResult = {
  keyword: string;
  metrics: Metrics;
  /** Google's KEYWORD_CONCEPT annotation, which only keyword ideas carry. */
  googleBrandConcept?: boolean;
};

type PlannerCall = (path: string, body: object) => Promise<unknown>;

/**
 * The normalizer of one Keyword Planner client. The account's dollar rate and
 * the project's intent rules load once per client, and only when an answer
 * needs them.
 */
export function createPlannerItemMapper(
  call: PlannerCall,
  customerId: string,
  projectId: string,
) {
  let usdRate: Promise<number | null> | undefined;
  const intentRules = new Map<string, Promise<IntentRules | null>>();

  return async (
    results: PlannerResult[],
    languageCode: string,
  ): Promise<AdsKeywordItem[]> => {
    const usdPerUnit = results.some(
      (result) => cpcMicros(result.metrics) != null,
    )
      ? await (usdRate ??= usdPerAccountCurrencyUnit(call, customerId))
      : null;
    if (!intentRules.has(languageCode)) {
      intentRules.set(languageCode, loadIntentRules(projectId, languageCode));
    }
    const rules = await intentRules.get(languageCode);
    return results.map((result) =>
      toAdsKeywordItem(
        result,
        usdPerUnit,
        rules
          ? ruleIntent(rules, result.keyword, result.googleBrandConcept)
          : null,
      ),
    );
  };
}

/**
 * US dollars per unit of the Ads account's currency, since OpenSEO shows CPC
 * in dollars as DataForSEO does: 1 for a dollar account, the day's TRM for a
 * Colombian peso account, and null (no CPC) for any other currency or when
 * either lookup fails. The currency comes from the account itself and is
 * cached for the month like every Keyword Planner answer.
 */
async function usdPerAccountCurrencyUnit(
  call: PlannerCall,
  customerId: string,
): Promise<number | null> {
  try {
    const payload = await call(`customers/${customerId}/googleAds:search`, {
      query: "SELECT customer.currency_code FROM customer",
    });
    const currency =
      customerCurrencySchema.parse(payload).results[0].customer.currencyCode;
    if (currency === "USD") return 1;
    if (currency === "COP") {
      const copPerUsd = await getCopPerUsd();
      return copPerUsd ? 1 / copPerUsd : null;
    }
    console.warn("google_ads.cpc_currency_unsupported", { currency });
  } catch (error) {
    console.warn("google_ads.cpc_currency_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

/**
 * The average CPC in micros of the account's currency, or the midpoint of the
 * top-of-page bid range when Google reports no average.
 */
function cpcMicros(metrics: Metrics): number | null {
  if (metrics?.averageCpcMicros != null) return metrics.averageCpcMicros;
  const bids = [
    metrics?.lowTopOfPageBidMicros,
    metrics?.highTopOfPageBidMicros,
  ].filter((bid) => bid != null);
  return bids.length > 0
    ? bids.reduce((sum, bid) => sum + bid, 0) / bids.length
    : null;
}

function toAdsKeywordItem(
  { keyword, metrics }: PlannerResult,
  usdPerUnit: number | null,
  intent: KeywordIntent | null,
): AdsKeywordItem {
  const micros = cpcMicros(metrics);
  return {
    keyword,
    search_volume: metrics?.avgMonthlySearches ?? null,
    cpc:
      micros != null && usdPerUnit != null
        ? Math.round((micros / 1_000_000) * usdPerUnit * 100) / 100
        : null,
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
    intent,
  };
}
