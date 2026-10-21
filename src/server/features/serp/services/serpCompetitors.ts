import { mean, median, uniqueBy } from "remeda";
import { getDomain } from "tldts";
import { normalizeKeyword } from "@/server/features/keywords/services/research/helpers";
import { SerpObservationRepository } from "@/server/features/serp/repositories/SerpObservationRepository";
import {
  fetchBrightDataSerp,
  type BrightDataSerp,
} from "@/server/lib/brightDataSerp";
import { domainOf } from "@/server/lib/brightDataSerpSections";
import {
  fetchKeywordMetricsForList,
  type KeywordMetricRow,
} from "@/server/lib/dataforseo/keyword-metrics";
import { AppError } from "@/server/lib/errors";
import { getKeywordPlannerClient } from "@/server/lib/googleAdsKeywordPlanner";
import { ctrAt } from "@/shared/ctr-curve";

// Keywords without a saved first page are searched live, one Bright Data
// request each from the monthly budget, so one call searches at most this many.
export const MAX_LIVE_KEYWORDS = 10;

// A saved first page this recent answers for its keyword at no cost. Weekly
// rank checks keep every tracked keyword inside it, even after a missed run.
export const SAVED_PAGE_MAX_AGE_DAYS = 14;

// Sites a local pack listing links to when the business has no website of its
// own. A listing linking to one of them, or to none, is counted by its name.
const PROFILE_SITES = new Set([
  "business.site",
  "facebook.com",
  "g.page",
  "instagram.com",
  "linktr.ee",
  "rappi.com.co",
  "tiktok.com",
  "wa.me",
  "whatsapp.com",
]);

const TOP_CTR = ctrAt(1, { aiOverview: false });

type Section = "organic" | "local_pack";

type Market = {
  locationCode: number;
  languageCode: string;
  locationName?: string | null;
};

/** One keyword's first Google page, reduced to what competitors come from. */
type Page = {
  keyword: string;
  source: "saved" | "live";
  observedAt: string;
  device: "desktop" | "mobile";
  aiOverview: boolean;
  organic: Array<{ position: number; domain: string | null }>;
  localPack: Array<{
    position: number;
    domain: string | null;
    name: string | null;
  }>;
};

/** One competitor's best positions per keyword and its running totals. */
type Tally = {
  domain: string | null;
  name: string | null;
  organic: Map<string, number>;
  localPack: Map<string, number>;
  ctrShare: number;
  etv: number;
  paidTrafficCost: number | null;
};

function round(value: number, digits: number) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function siteOf(domain: string, includeSubdomains: boolean) {
  return includeSubdomains ? (getDomain(domain) ?? domain) : domain;
}

/**
 * A local pack listing is the business behind its website, or behind its
 * name when it links to a social or delivery profile, or to no site.
 */
function listingKey(
  listing: Page["localPack"][number],
  includeSubdomains: boolean,
) {
  const site = listing.domain ? getDomain(listing.domain) : null;
  if (
    listing.domain &&
    site &&
    !PROFILE_SITES.has(site) &&
    !site.startsWith("google.")
  ) {
    const domain = siteOf(listing.domain, includeSubdomains);
    return { key: domain, domain };
  }
  const name = listing.name?.trim();
  return name ? { key: `name:${name.toLowerCase()}`, domain: null } : null;
}

/**
 * Keyword Planner monthly searches and CPC per normalized keyword, or why
 * there are none. Free and cached by month, but Google refuses it until the
 * server's Cloud project has Basic access.
 */
async function plannerMetrics(
  owner: { userId: string; projectId: string },
  keywords: string[],
  market: Market,
): Promise<
  | { metrics: Map<string, KeywordMetricRow>; unavailable: null }
  | { metrics: null; unavailable: string }
> {
  const planner = await getKeywordPlannerClient(owner.userId, owner.projectId);
  if (!planner) {
    return {
      metrics: null,
      unavailable: "Google Ads Keyword Planner is not set up on this server.",
    };
  }
  try {
    const rows = await fetchKeywordMetricsForList(planner, {
      keywords,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      locationName: market.locationName ?? undefined,
      creditFeature: "keyword_research",
    });
    return {
      metrics: new Map(rows.map((row) => [normalizeKeyword(row.keyword), row])),
      unavailable: null,
    };
  } catch (error) {
    console.warn("[serp-competitors] Keyword Planner volumes failed:", error);
    return {
      metrics: null,
      unavailable:
        error instanceof AppError
          ? error.message
          : "Keyword Planner did not answer.",
    };
  }
}

/** Each keyword's saved first page from the store, and the keywords without one. */
async function savedPages(input: {
  organizationId: string;
  keywords: string[];
  market: Market;
}) {
  const saved = await SerpObservationRepository.findLatestForKeywords({
    organizationId: input.organizationId,
    ...input.market,
    keywords: input.keywords,
    since: new Date(
      Date.now() - SAVED_PAGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
  });
  const pages: Page[] = [];
  const missing: string[] = [];
  for (const keyword of input.keywords) {
    const page = saved.get(normalizeKeyword(keyword));
    if (!page) {
      missing.push(keyword);
      continue;
    }
    pages.push({
      keyword,
      source: "saved",
      observedAt: page.observedAt,
      device: page.device,
      aiOverview: page.features.includes("ai_overview"),
      organic: page.organic,
      localPack: page.localPack.map((row) => ({
        position: row.position,
        domain: row.domain,
        name: row.title,
      })),
    });
  }
  return { pages, missing };
}

/** Counts every competitor's best positions and CTR-based totals per page. */
function tallyCompetitors(
  pages: Page[],
  options: {
    sections: Section[];
    includeSubdomains: boolean;
    metrics: Map<string, KeywordMetricRow> | null;
  },
) {
  const tallies = new Map<string, Tally>();
  const tallyFor = (
    key: string,
    domain: string | null,
    name: string | null,
  ) => {
    const tally = tallies.get(key) ?? {
      domain,
      name: null,
      organic: new Map<string, number>(),
      localPack: new Map<string, number>(),
      ctrShare: 0,
      etv: 0,
      paidTrafficCost: null,
    };
    tally.name ??= name;
    tallies.set(key, tally);
    return tally;
  };

  for (const page of pages) {
    const best = new Map<Tally, { organic?: number; localPack?: number }>();
    const see = (
      tally: Tally,
      section: "organic" | "localPack",
      position: number,
    ) => {
      const at = best.get(tally) ?? {};
      at[section] = Math.min(at[section] ?? Infinity, position);
      best.set(tally, at);
    };
    if (options.sections.includes("organic")) {
      for (const item of page.organic) {
        if (!item.domain) continue;
        const domain = siteOf(item.domain, options.includeSubdomains);
        see(tallyFor(domain, domain, null), "organic", item.position);
      }
    }
    if (options.sections.includes("local_pack")) {
      for (const listing of page.localPack) {
        const identity = listingKey(listing, options.includeSubdomains);
        if (!identity) continue;
        see(
          tallyFor(identity.key, identity.domain, listing.name),
          "localPack",
          listing.position,
        );
      }
    }

    const metric = options.metrics?.get(normalizeKeyword(page.keyword));
    const searches = metric?.searchVolume ?? 0;
    for (const [tally, at] of best) {
      if (at.organic != null) tally.organic.set(page.keyword, at.organic);
      if (at.localPack != null) tally.localPack.set(page.keyword, at.localPack);
      // A business in both sections gets the clicks of its better one.
      const ctr = Math.max(
        at.organic == null ? 0 : ctrAt(at.organic, page),
        at.localPack == null ? 0 : ctrAt(at.localPack, page),
      );
      tally.ctrShare += ctr / TOP_CTR;
      tally.etv += searches * ctr;
      if (metric?.cpc != null) {
        tally.paidTrafficCost =
          (tally.paidTrafficCost ?? 0) + searches * ctr * metric.cpc;
      }
    }
  }
  return [...tallies.values()];
}

/**
 * Who competes on the first Google page of these keywords: organic results
 * and the local pack. A keyword with a first page this organization saved in
 * the last SAVED_PAGE_MAX_AGE_DAYS days, by a rank check or a SERP tool on
 * either device, is read from the store at no cost. The rest are searched
 * live on Bright Data, at most MAX_LIVE_KEYWORDS per call, and saved.
 *
 * Rows use find_serp_competitors' DataForSEO-shaped fields. Visibility is the
 * sum of each keyword's CTR at the competitor's best position over what a #1
 * on every keyword would get, from the single CTR curve. ETV is Keyword
 * Planner monthly searches times that CTR, and paid traffic cost ETV times
 * CPC; both are null without Keyword Planner data.
 */
export async function findSerpCompetitors(
  config: BrightDataSerp,
  input: {
    organizationId: string;
    userId: string;
    projectId: string;
    keywords: string[];
    market: Market;
    /** The device of live searches; saved pages count from either device. */
    device: "desktop" | "mobile";
    sections: Section[];
    includeSubdomains: boolean;
  },
) {
  const keywords = uniqueBy(input.keywords, normalizeKeyword);
  const { pages, missing } = await savedPages({ ...input, keywords });

  const live = missing.slice(0, MAX_LIVE_KEYWORDS);
  const settled = await Promise.allSettled(
    live.map((keyword) =>
      fetchBrightDataSerp(config, {
        keyword,
        market: input.market,
        device: input.device,
        depth: 10,
        observation: {
          organizationId: input.organizationId,
          origin: "serp_tool",
        },
      }),
    ),
  );
  const failed: Array<{ keyword: string; reason: unknown }> = [];
  let usedThisMonth: number | null = null;
  for (const [index, outcome] of settled.entries()) {
    const keyword = live[index] ?? "";
    if (outcome.status === "rejected") {
      failed.push({ keyword, reason: outcome.reason });
      continue;
    }
    const serp = outcome.value;
    usedThisMonth = Math.max(usedThisMonth ?? 0, serp.usedThisMonth);
    pages.push({
      keyword,
      source: "live",
      observedAt: new Date().toISOString(),
      device: input.device,
      aiOverview: serp.features.includes("ai_overview"),
      organic: serp.organic,
      localPack: serp.localPack.map((item) => ({
        position: item.position,
        domain: domainOf(item.url),
        name: item.title,
      })),
    });
  }
  if (pages.length === 0 && failed[0]) throw failed[0].reason;

  const { metrics, unavailable } = await plannerMetrics(
    input,
    pages.map((page) => page.keyword),
    input.market,
  );
  const competitors = tallyCompetitors(pages, { ...input, metrics }).map(
    (tally) => {
      const ranks = [...tally.organic.values()];
      const packRanks = [...tally.localPack.values()];
      return {
        domain: tally.domain,
        name: tally.name,
        keywords_count: new Set([
          ...tally.organic.keys(),
          ...tally.localPack.keys(),
        ]).size,
        avg_position: ranks.length > 0 ? round(mean(ranks) ?? 0, 1) : null,
        median_position: median(ranks) ?? null,
        local_pack_avg_position:
          packRanks.length > 0 ? round(mean(packRanks) ?? 0, 1) : null,
        visibility: round(tally.ctrShare / pages.length, 3),
        etv: metrics ? round(tally.etv, 1) : null,
        estimated_paid_traffic_cost:
          tally.paidTrafficCost == null
            ? null
            : round(tally.paidTrafficCost, 2),
        keywords_positions: Object.fromEntries(tally.organic),
        local_pack_positions: Object.fromEntries(tally.localPack),
      };
    },
  );

  return {
    competitors,
    pages: pages.map((page) => ({
      keyword: page.keyword,
      source: page.source,
      observed_at: page.observedAt,
      device: page.device,
      ai_overview: page.aiOverview ? "detected" : "not_detected",
    })),
    failed,
    notChecked: missing.slice(MAX_LIVE_KEYWORDS),
    usedThisMonth,
    volumesUnavailable: unavailable,
  };
}
