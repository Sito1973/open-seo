import { median, uniqueBy } from "remeda";
import { getDomainWithoutSuffix } from "tldts";
import { GooglePlacesUsageRepository } from "@/server/features/google-places/repositories/GooglePlacesUsageRepository";
import { KeywordDifficultyEstimateRepository } from "@/server/features/keywords/repositories/KeywordDifficultyEstimateRepository";
import { normalizeKeyword } from "@/server/features/keywords/services/research/helpers";
import { SerpObservationRepository } from "@/server/features/serp/repositories/SerpObservationRepository";
import { projectSearchTracker } from "@/server/features/serp/services/googleCandidates";
import { SAVED_PAGE_MAX_AGE_DAYS } from "@/server/features/serp/services/serpCompetitors";
import {
  fetchBrightDataSerp,
  getBrightDataSerp,
  type BrightDataSerp,
} from "@/server/lib/brightDataSerp";
import { AppError } from "@/server/lib/errors";
import { fetchOpenPageRanks } from "@/server/lib/openPageRank";
import { ctrAt } from "@/shared/ctr-curve";
import { resolveMarket } from "@/shared/keyword-locations";

// OpenSEO's keyword difficulty estimate (0-100) for self-hosted installs on
// Bright Data, where DataForSEO's is unavailable. It reads one saved first
// Google page of the keyword:
// - local: how entrenched the local pack is, from its median review count on
//   a log scale (about 50 reviews -> 25, 500 -> 58, 3,000 -> 84);
// - organic: the top 10's Open PageRank (0-10, x10), averaged with the CTR
//   curve as weights so the top results count most, minus 10 for each top-5
//   result on a social network, forum, directory or delivery platform, which a
//   business's own page can pass.
// With a local pack the estimate is 0.6 local + 0.4 organic; without one it is
// organic alone; without OPENPAGERANK_API_KEY it is local alone, so a page
// without a local pack gets no estimate.

/** Keywords without a saved page searched live in one call, at most. */
export const MAX_LIVE_ESTIMATES = 10;

// Live searches for estimates, a share of the Bright Data budget that rank
// tracking needs most. There is deliberately no setting to raise it.
const MONTHLY_LIVE_ESTIMATES = 300;

const LOCAL_WEIGHT = 0.6;
const OPEN_SITE_PENALTY = 10;

// Matched on the domain's name without its suffix, so every country's
// tripadvisor or facebook counts.
const OPEN_SITES = new Set([
  "facebook",
  "foursquare",
  "google",
  "instagram",
  "linkedin",
  "linktr",
  "paginasamarillas",
  "pinterest",
  "quora",
  "rappi",
  "reddit",
  "restaurantguru",
  "tiktok",
  "tripadvisor",
  "twitter",
  "ubereats",
  "wa",
  "whatsapp",
  "x",
  "yelp",
  "youtube",
]);

type Market = {
  locationCode: number;
  languageCode: string;
  locationName?: string | null;
};

type Page = {
  keyword: string;
  source: "saved" | "live";
  observedAt: string;
  organic: Array<{ position: number; domain: string | null }>;
  localPack: Array<{ reviewsCount: number | null }>;
};

const clamp = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

function localScore(page: Page): number | null {
  const middle = median(
    page.localPack.flatMap((listing) =>
      listing.reviewsCount == null ? [] : [listing.reviewsCount],
    ),
  );
  if (middle === undefined) return null;
  return clamp(33 * Math.log10(Math.max(middle, 1)) - 31);
}

function organicScore(
  page: Page,
  authority: Map<string, number | null>,
): number | null {
  const top = page.organic.flatMap((result) =>
    result.domain && result.position <= 10
      ? [{ position: result.position, domain: result.domain }]
      : [],
  );
  if (top.length === 0) return null;
  let weighted = 0;
  let weights = 0;
  for (const result of top) {
    const weight = ctrAt(result.position, { aiOverview: false });
    // A domain Open PageRank does not know has no authority to speak of.
    weighted += weight * (authority.get(result.domain) ?? 0) * 10;
    weights += weight;
  }
  const openSites = top.filter(
    (result) =>
      result.position <= 5 &&
      OPEN_SITES.has(getDomainWithoutSuffix(result.domain) ?? ""),
  ).length;
  return clamp(weighted / weights - OPEN_SITE_PENALTY * openSites);
}

function combine(local: number | null, organic: number | null) {
  if (local != null && organic != null) {
    return clamp(LOCAL_WEIGHT * local + (1 - LOCAL_WEIGHT) * organic);
  }
  return local ?? organic;
}

async function reserveLiveEstimate() {
  const month = new Date().toISOString().slice(0, 7);
  const used = await GooglePlacesUsageRepository.reserveCalls({
    month,
    sku: "difficulty_estimate",
    count: 1,
    limit: MONTHLY_LIVE_ESTIMATES,
  });
  if (used == null) {
    throw new AppError(
      "MONTHLY_BUDGET_EXHAUSTED",
      `This server's monthly budget for difficulty estimates (${MONTHLY_LIVE_ESTIMATES} live Google searches in ${month}, UTC) is used up, so no request was sent. Keywords with a page saved by a rank check or SERP tool in the last ${SAVED_PAGE_MAX_AGE_DAYS} days still get an estimate. It resets on the 1st.`,
    );
  }
}

/**
 * Estimates keyword difficulty for these keywords and saves each estimate for
 * the project. A keyword with a first page this organization saved in the last
 * SAVED_PAGE_MAX_AGE_DAYS days in this market, from either device, costs no
 * request. Up to `maxLive` others are searched live on Bright Data on
 * `device`, one request each from both the monthly estimate budget and the
 * Bright Data budget, and their pages are saved too.
 */
export async function estimateKeywordDifficulty(
  config: BrightDataSerp,
  input: {
    organizationId: string;
    projectId: string;
    keywords: string[];
    market: Market;
    device: "desktop" | "mobile";
    maxLive: number;
  },
) {
  const keywords = uniqueBy(input.keywords, normalizeKeyword);
  const saved = await SerpObservationRepository.findLatestForKeywords({
    organizationId: input.organizationId,
    ...input.market,
    keywords,
    since: new Date(
      Date.now() - SAVED_PAGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
  });
  const pages: Page[] = [];
  const missing: string[] = [];
  for (const keyword of keywords) {
    const page = saved.get(normalizeKeyword(keyword));
    if (page) pages.push({ ...page, keyword, source: "saved" });
    else missing.push(keyword);
  }

  const live = missing.slice(0, input.maxLive);
  const settled = await Promise.allSettled(
    live.map(async (keyword) => {
      await reserveLiveEstimate();
      return fetchBrightDataSerp(config, {
        keyword,
        market: input.market,
        device: input.device,
        depth: 10,
        observation: {
          organizationId: input.organizationId,
          origin: "research",
        },
      });
    }),
  );
  const failed: Array<{ keyword: string; reason: unknown }> = [];
  let usedThisMonth: number | null = null;
  for (const [index, outcome] of settled.entries()) {
    const keyword = live[index] ?? "";
    if (outcome.status === "rejected") {
      failed.push({ keyword, reason: outcome.reason });
      continue;
    }
    usedThisMonth = Math.max(usedThisMonth ?? 0, outcome.value.usedThisMonth);
    pages.push({
      keyword,
      source: "live",
      observedAt: new Date().toISOString(),
      organic: outcome.value.organic,
      localPack: outcome.value.localPack,
    });
  }

  const hosts = [
    ...new Set(
      pages.flatMap((page) =>
        page.organic.flatMap((result) =>
          result.domain && result.position <= 10 ? [result.domain] : [],
        ),
      ),
    ),
  ];
  const authority =
    hosts.length > 0
      ? await fetchOpenPageRanks(hosts)
      : { scores: new Map<string, number | null>(), unavailable: null };

  const computedAt = new Date().toISOString();
  const estimates = pages.map((page) => {
    const local = localScore(page);
    const organic = authority.scores
      ? organicScore(page, authority.scores)
      : null;
    return {
      keyword: page.keyword,
      source: page.source,
      observedAt: page.observedAt,
      keywordDifficulty: combine(local, organic),
      localScore: local,
      organicScore: organic,
    };
  });
  await KeywordDifficultyEstimateRepository.upsert(
    estimates.flatMap((estimate) =>
      estimate.keywordDifficulty == null
        ? []
        : [
            {
              projectId: input.projectId,
              keyword: normalizeKeyword(estimate.keyword),
              locationCode: input.market.locationCode,
              languageCode: input.market.languageCode,
              keywordDifficulty: estimate.keywordDifficulty,
              localScore: estimate.localScore,
              organicScore: estimate.organicScore,
              locationName: input.market.locationName ?? null,
              observedAt: estimate.observedAt,
              computedAt,
            },
          ],
    ),
  );

  return {
    estimates,
    failed,
    notChecked: missing.slice(input.maxLive),
    authorityUnavailable: authority.unavailable,
    usedThisMonth,
  };
}

/**
 * On-demand estimates for a project's keywords in one market (the project's by
 * default), at most MAX_LIVE_ESTIMATES live searches per call. On the
 * project's own market the search runs near its rank tracker's city and on its
 * device, as find_serp_competitors does, so the tracker's saved pages answer
 * for free and new pages serve its next check.
 */
export async function estimateProjectKeywordDifficulty(input: {
  organizationId: string;
  project: { id: string; locationCode: number; languageCode: string };
  keywords: string[];
  locationCode?: number;
  languageCode?: string;
}) {
  const config = await getBrightDataSerp();
  if (!config) {
    throw new AppError(
      "VALIDATION_ERROR",
      "This server does not estimate keyword difficulty: it needs Bright Data (BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE) on a self-hosted install without DataForSEO for other features. Where DataForSEO is set, research_keywords and get_keyword_metrics return its keyword difficulty.",
    );
  }
  const market = resolveMarket(input, input.project);
  const nearby =
    market.locationCode === input.project.locationCode &&
    market.languageCode === input.project.languageCode
      ? await projectSearchTracker(input.project)
      : null;
  const searchMarket = nearby?.market ?? market;
  const device = nearby?.device ?? "desktop";
  const result = await estimateKeywordDifficulty(config, {
    organizationId: input.organizationId,
    projectId: input.project.id,
    keywords: input.keywords,
    market: searchMarket,
    device,
    maxLive: MAX_LIVE_ESTIMATES,
  });
  return { ...result, market: searchMarket, device };
}

/** Whether this server estimates keyword difficulty (Bright Data is set). */
export async function difficultyEstimateStatus() {
  return { available: (await getBrightDataSerp()) != null };
}

/**
 * The project's stored estimates for these keywords in one market, keyed by
 * normalized keyword, for reads that show them next to the provider's
 * difficulty. Only a server that estimates (Bright Data standing in for
 * DataForSEO) reads them; hosted and DataForSEO installs skip the query.
 */
export async function storedDifficultyEstimates(input: {
  projectId: string;
  locationCode: number;
  languageCode: string;
  keywords: string[];
}): Promise<Map<string, number>> {
  if (input.keywords.length === 0 || !(await getBrightDataSerp())) {
    return new Map();
  }
  const rows = await KeywordDifficultyEstimateRepository.findForKeywords(input);
  return new Map(
    [...rows].map(([keyword, row]) => [keyword, row.keywordDifficulty]),
  );
}
