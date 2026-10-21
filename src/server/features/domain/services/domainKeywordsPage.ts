import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import { parseResearchTargetOrThrow } from "@/server/lib/domainUtils";
import { buildRankedKeywordsScopeFilter } from "@/server/lib/dataforseo/researchScopeFilters";
import type { ResearchScope } from "@/shared/researchScope";
import { mapKeywordItem } from "@/server/features/domain/services/domainKeywordMapper";
import { computeHasMore } from "@/server/features/domain/services/pagination";
import { filterSortPage } from "@/server/features/domain/services/filterSortPage";
import {
  loadOwnSiteData,
  type OwnSiteData,
} from "@/server/features/domain/services/searchConsoleDomain";
import {
  buildKeywordFilters,
  buildOrderBy,
  type DomainKeywordsSortMode,
  type DomainKeywordsSortOrder,
} from "@/server/features/domain/services/domainKeywordFilters";
import type { DomainKeywordsFilters } from "@/types/schemas/domain";

const DOMAIN_KEYWORDS_PAGE_TTL_SECONDS = 12 * 60 * 60;

const domainKeywordsPageResultSchema = z.object({
  domain: z.string(),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number().nullable(),
  hasMore: z.boolean(),
  keywords: z.array(
    z.object({
      keyword: z.string(),
      position: z.number().nullable(),
      searchVolume: z.number().nullable(),
      traffic: z.number().nullable(),
      cpc: z.number().nullable(),
      url: z.string().nullable(),
      relativeUrl: z.string().nullable(),
      keywordDifficulty: z.number().nullable(),
      /** Search Console impressions; only on `dataSource: "gsc"` rows. */
      impressions: z.number().optional(),
    }),
  ),
  fetchedAt: z.string(),
  /** Set when the rows come from Search Console instead of DataForSEO. */
  dataSource: z.literal("gsc").optional(),
});

type DomainKeywordsPageResult = z.infer<typeof domainKeywordsPageResultSchema>;
type DomainKeywordsPageInput = Parameters<typeof getKeywordsPage>[0];

const OWN_SITE_SORT_FIELD: Record<
  DomainKeywordsSortMode,
  (row: OwnSiteData["keywords"][number]) => number | null
> = {
  rank: (row) => row.position,
  traffic: (row) => row.clicks,
  volume: (row) => row.searchVolume,
  score: (row) => row.keywordDifficulty,
  cpc: (row) => row.cpc,
};

/** The same page from the organization's own Search Console data. */
function ownSiteKeywordsPage(
  ownSite: OwnSiteData,
  input: DomainKeywordsPageInput,
  domain: string,
): DomainKeywordsPageResult {
  const page = filterSortPage(
    ownSite.keywords,
    {
      terms: (row) => row.keyword,
      search: (row) => [row.keyword, row.url],
      ranges: {
        Traffic: (row) => row.clicks,
        Vol: (row) => row.searchVolume,
        Cpc: (row) => row.cpc,
        Kd: (row) => row.keywordDifficulty,
        Rank: (row) => row.position,
      },
    },
    {
      filters: input.filters,
      search: input.search,
      sortBy: OWN_SITE_SORT_FIELD[input.sortMode],
      sortOrder: input.sortOrder,
      offset: (input.page - 1) * input.pageSize,
      limit: input.pageSize,
    },
  );
  return {
    domain,
    page: input.page,
    pageSize: input.pageSize,
    totalCount: page.totalCount,
    hasMore: page.hasMore,
    keywords: page.rows.map((row) => ({
      keyword: row.keyword,
      position: row.position,
      searchVolume: row.searchVolume,
      traffic: row.clicks,
      cpc: row.cpc,
      url: row.url,
      relativeUrl: row.relativeUrl,
      keywordDifficulty: row.keywordDifficulty,
      impressions: row.impressions,
    })),
    fetchedAt: new Date().toISOString(),
    dataSource: "gsc",
  };
}

export async function getKeywordsPage(
  input: {
    projectId: string;
    domain: string;
    scope?: ResearchScope;
    locationCode: number;
    languageCode: string;
    page: number;
    pageSize: number;
    sortMode: DomainKeywordsSortMode;
    sortOrder: DomainKeywordsSortOrder;
    filters: DomainKeywordsFilters;
    search?: string;
  },
  billingCustomer: BillingCustomerContext,
): Promise<DomainKeywordsPageResult> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);
  const ownSite = await loadOwnSiteData({
    ...input,
    organizationId: billingCustomer.organizationId,
    target,
  });
  if (ownSite) return ownSiteKeywordsPage(ownSite, input, target.hostname);

  const scopeFilter = buildRankedKeywordsScopeFilter(target);
  const offset = (input.page - 1) * input.pageSize;
  const orderBy = buildOrderBy(input.sortMode, input.sortOrder);
  const filters = buildKeywordFilters(input.filters, input.search, scopeFilter);

  const cacheKey = await buildCacheKey("domain:keywords-page", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    domain: target.hostname,
    scope: target.scope,
    path: target.path,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    page: input.page,
    pageSize: input.pageSize,
    sortMode: input.sortMode,
    sortOrder: input.sortOrder,
    filters: input.filters,
    search: input.search,
  });

  const cachedRaw = await getCached(cacheKey);
  const cached = domainKeywordsPageResultSchema.safeParse(cachedRaw);
  if (cached.success) {
    return cached.data;
  }

  const dataforseo = createDataforseoClient(billingCustomer);
  const response = await dataforseo.domain.rankedKeywords({
    target: target.hostname,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    limit: input.pageSize,
    offset,
    orderBy,
    filters: filters.length > 0 ? filters : undefined,
  });

  const keywords = response.items
    .map((item) => mapKeywordItem(item))
    .filter(
      (item): item is NonNullable<ReturnType<typeof mapKeywordItem>> =>
        item != null,
    );

  const totalCount = response.totalCount;
  const hasMore = computeHasMore(
    offset,
    response.items.length,
    totalCount,
    input.pageSize,
  );

  const result: DomainKeywordsPageResult = {
    domain: target.hostname,
    page: input.page,
    pageSize: input.pageSize,
    totalCount,
    hasMore,
    keywords,
    fetchedAt: new Date().toISOString(),
  };

  // waitUntil, not void: workerd cancels unregistered pending I/O once the
  // response is sent, so a fire-and-forget put never persists the cache.
  waitUntil(
    setCached(cacheKey, result, DOMAIN_KEYWORDS_PAGE_TTL_SECONDS).catch(
      (error) => {
        console.error("domain.keywords-page.cache-write failed:", error);
      },
    ),
  );

  return result;
}
