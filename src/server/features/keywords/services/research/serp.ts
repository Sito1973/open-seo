import { waitUntil } from "cloudflare:workers";
import {
  SERP_ANALYSIS_DEPTH,
  type SerpLiveItem,
} from "@/server/lib/dataforseo";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import type { SerpResultItem } from "@/types/keywords";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import {
  fetchBrightDataSerp,
  getBrightDataSerp,
  type BrightDataSerp,
} from "@/server/lib/brightDataSerp";
import { normalizeKeyword } from "./helpers";
import { assertLocalResearchLocation } from "./local-volume";

const SERP_CACHE_TTL_SECONDS = 12 * 60 * 60;
// DataForSEO crawls up to 100 rows. Bright Data costs one request from the
// server's monthly budget per page of 10, so the card stops at 50.
const DATAFORSEO_MAX_DEPTH = 100;
const BRIGHTDATA_MAX_DEPTH = 50;

type SerpAnalysisReason = "no_organic_results";

type SerpAnalysisResult = {
  requestedKeyword: string;
  items: SerpResultItem[];
  /** SERP depth this snapshot was crawled at — how deep the results go. */
  depth: number;
  /** The deepest snapshot this server fetches, so the card knows when to stop. */
  maxDepth: number;
  reason?: SerpAnalysisReason;
};

const serpResultItemSchema = z.object({
  rank: z.number().int(),
  title: z.string(),
  url: z.string(),
  domain: z.string(),
  description: z.string(),
  etv: z.number().nullable(),
  estimatedPaidTrafficCost: z.number().nullable(),
  referringDomains: z.number().nullable(),
  backlinks: z.number().nullable(),
  isNew: z.boolean(),
  rankChange: z.number().nullable(),
});

const serpCacheSchema = z.object({
  requestedKeyword: z.string(),
  items: z.array(serpResultItemSchema),
  // Entries written before depth was tracked don't say how deep they went, so
  // they're treated as the shallow floor: worst case a user re-buys a deeper
  // crawl once, rather than being shown 20 results as if they were 100.
  depth: z.number().int().default(SERP_ANALYSIS_DEPTH),
  reason: z.enum(["no_organic_results"]).optional(),
});

function mapOrganicSerpItems(items: SerpLiveItem[]): SerpResultItem[] {
  return items
    .filter((item) => item.type === "organic")
    .map((item) => ({
      rank: item.rank_group ?? item.rank_absolute ?? 0,
      title: item.title ?? "",
      url: item.url ?? "",
      domain: item.domain ?? "",
      description: item.description ?? "",
      etv: item.etv ?? null,
      estimatedPaidTrafficCost: item.estimated_paid_traffic_cost ?? null,
      referringDomains: item.backlinks_info?.referring_domains ?? null,
      backlinks: item.backlinks_info?.backlinks ?? null,
      isNew: false,
      rankChange: null,
    }));
}

async function getSerpLiveAnalysis(
  input: {
    projectId: string;
    keyword: string;
    locationCode: number;
    languageCode: string;
    depth: number;
    locationName?: string;
  },
  billingCustomer: BillingCustomerContext,
): Promise<SerpAnalysisResult> {
  const keyword = normalizeKeyword(input.keyword);
  if (input.locationName) {
    await assertLocalResearchLocation(input.locationCode, input.locationName);
  }
  const brightData = await getBrightDataSerp();
  if (brightData) {
    return getBrightDataAnalysis(
      brightData,
      { ...input, keyword },
      billingCustomer,
    );
  }
  const { depth } = input;

  const cacheKey = await buildCacheKey("serp:analysis", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    keyword,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    locationName: input.locationName,
  });

  // Depth lives in the cached value, not the key: DataForSEO has no offset, so
  // a deeper crawl re-fetches the head too. A depth-100 snapshot therefore also
  // answers depth-20 requests, and a deeper request replaces the entry rather
  // than appending to it.
  const cachedRaw = await getCached(cacheKey);
  const cached = serpCacheSchema.safeParse(cachedRaw);
  if (cached.success && cached.data.depth >= depth) {
    return { ...cached.data, maxDepth: DATAFORSEO_MAX_DEPTH };
  }

  const liveItems = await createDataforseoClient(billingCustomer).serp.live({
    keyword,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    locationName: input.locationName,
    depth,
  });

  const items = mapOrganicSerpItems(liveItems);
  const result: SerpAnalysisResult = {
    requestedKeyword: keyword,
    items,
    depth,
    maxDepth: DATAFORSEO_MAX_DEPTH,
  };
  if (items.length === 0) {
    result.reason = "no_organic_results";
  }

  // DataForSEO reports "no results" transiently, and a deeper crawl overwrites
  // the same key. Without this guard one empty re-crawl would evict a good
  // snapshot and, being the deeper entry, answer every shallower request with
  // nothing for the rest of the TTL.
  if (items.length === 0 && cached.success && cached.data.items.length > 0) {
    return result;
  }

  cacheSnapshot(cacheKey, result);
  return result;
}

function cacheSnapshot(cacheKey: string, result: SerpAnalysisResult) {
  // waitUntil, not void: workerd cancels unregistered pending I/O once the
  // response is sent, so a fire-and-forget put never persists the cache.
  waitUntil(
    setCached(cacheKey, result, SERP_CACHE_TTL_SECONDS).catch((error) => {
      console.error("keywords.serp.cache-write failed:", error);
    }),
  );
}

/**
 * A self-hosted install without DataForSEO reads the card from Bright Data,
 * one request from the server's monthly budget per page of 10, to depth 50.
 * Google pages by offset there, so a deeper request fetches only the pages
 * after the cached snapshot and appends them. Bright Data has no traffic
 * estimates or backlink counts per URL, so those stay null.
 */
async function getBrightDataAnalysis(
  config: BrightDataSerp,
  input: {
    projectId: string;
    keyword: string;
    locationCode: number;
    languageCode: string;
    depth: number;
    locationName?: string;
  },
  billingCustomer: BillingCustomerContext,
): Promise<SerpAnalysisResult> {
  const { keyword } = input;
  const depth = Math.min(input.depth, BRIGHTDATA_MAX_DEPTH);
  const cacheKey = await buildCacheKey("serp:analysis", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    keyword,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    locationName: input.locationName,
    provider: "brightdata",
  });
  const cached = serpCacheSchema.safeParse(await getCached(cacheKey));
  if (cached.success && cached.data.depth >= depth) {
    return { ...cached.data, maxDepth: BRIGHTDATA_MAX_DEPTH };
  }
  const head =
    cached.success && cached.data.items.length > 0 ? cached.data : null;

  const serp = await fetchBrightDataSerp(
    config,
    {
      keyword,
      market: input,
      device: "desktop",
      depth,
      observation: {
        organizationId: billingCustomer.organizationId,
        origin: "research",
      },
    },
    head
      ? {
          pages: Math.ceil(head.depth / 10),
          organicCount: head.items.length,
        }
      : undefined,
  );
  const items: SerpResultItem[] = [
    ...(head?.items ?? []),
    ...serp.organic.map((item) => ({
      rank: item.position,
      title: item.title ?? "",
      url: item.url ?? "",
      domain: item.domain ?? "",
      description: item.description ?? "",
      etv: null,
      estimatedPaidTrafficCost: null,
      referringDomains: null,
      backlinks: null,
      isNew: false,
      rankChange: null,
    })),
  ];
  const result: SerpAnalysisResult = {
    requestedKeyword: keyword,
    items,
    depth,
    maxDepth: BRIGHTDATA_MAX_DEPTH,
    ...(items.length === 0 ? { reason: "no_organic_results" as const } : {}),
  };
  if (items.length > 0) cacheSnapshot(cacheKey, result);
  return result;
}

export const getSerpAnalysis = getSerpLiveAnalysis;
