import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import {
  parseResearchTargetOrThrow,
  toRelativePath,
} from "@/server/lib/domainUtils";
import {
  buildRelevantPagesScopeFilter,
  type ScopeFilter,
} from "@/server/lib/dataforseo/researchScopeFilters";
import { assertFilterConditionBudget } from "@/server/lib/dataforseo/filters";
import type { ResearchScope } from "@/shared/researchScope";
import type { RelevantPagesItem } from "@/server/lib/dataforseo";
import { computeHasMore } from "@/server/features/domain/services/pagination";
import { filterSortPage } from "@/server/features/domain/services/filterSortPage";
import {
  loadOwnSiteData,
  type OwnSiteData,
} from "@/server/features/domain/services/searchConsoleDomain";
import type { DomainKeywordsFilters } from "@/types/schemas/domain";

const DOMAIN_PAGES_PAGE_TTL_SECONDS = 12 * 60 * 60;

type DomainPagesSortMode = "traffic" | "keywords";
type DomainPagesSortOrder = "asc" | "desc";

const SORT_FIELD_BY_MODE: Record<DomainPagesSortMode, string> = {
  traffic: "metrics.organic.etv",
  keywords: "metrics.organic.count",
};

const domainPagesPageResultSchema = z.object({
  domain: z.string(),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number().nullable(),
  hasMore: z.boolean(),
  pages: z.array(
    z.object({
      page: z.string(),
      relativePath: z.string().nullable(),
      organicTraffic: z.number().nullable(),
      keywords: z.number().nullable(),
    }),
  ),
  fetchedAt: z.string(),
  /** Set when the rows come from Search Console instead of DataForSEO. */
  dataSource: z.literal("gsc").optional(),
});

type DomainPagesPageResult = z.infer<typeof domainPagesPageResultSchema>;

/** The same page from the organization's own Search Console data. */
function ownSitePagesPage(
  ownSite: OwnSiteData,
  input: Parameters<typeof getPagesPage>[0],
  domain: string,
): DomainPagesPageResult {
  const page = filterSortPage(
    ownSite.pages,
    {
      terms: (row) => row.page,
      search: (row) => [row.page],
      ranges: {
        Traffic: (row) => row.clicks,
        Vol: (row) => row.keywords,
      },
    },
    {
      filters: input.filters,
      search: input.search,
      sortBy: (row) =>
        input.sortMode === "keywords" ? row.keywords : row.clicks,
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
    pages: page.rows.map((row) => ({
      page: row.page,
      relativePath: row.relativePath,
      organicTraffic: row.clicks,
      keywords: row.keywords,
    })),
    fetchedAt: new Date().toISOString(),
    dataSource: "gsc",
  };
}

function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function pushAnd(filters: unknown[], expression: unknown[]) {
  if (filters.length > 0) filters.push("and");
  filters.push(expression);
}

function collectNumericRange(
  out: unknown[][],
  field: string,
  min: number | undefined,
  max: number | undefined,
) {
  if (typeof min === "number" && Number.isFinite(min)) {
    out.push([field, ">=", min]);
  }
  if (typeof max === "number" && Number.isFinite(max)) {
    out.push([field, "<=", max]);
  }
}

function parseTerms(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(/[,+]/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function buildPageFilters(
  filters: DomainKeywordsFilters,
  searchTerm: string | undefined,
  scopeFilter: ScopeFilter,
): unknown[] {
  const conditions: unknown[][] = [];

  for (const term of parseTerms(filters.include)) {
    conditions.push(["page_address", "ilike", `%${escapeLikeTerm(term)}%`]);
  }
  for (const term of parseTerms(filters.exclude)) {
    conditions.push(["page_address", "not_ilike", `%${escapeLikeTerm(term)}%`]);
  }

  collectNumericRange(
    conditions,
    "metrics.organic.etv",
    filters.minTraffic,
    filters.maxTraffic,
  );
  collectNumericRange(
    conditions,
    "metrics.organic.count",
    filters.minVol,
    filters.maxVol,
  );

  const trimmed = searchTerm?.trim();
  if (trimmed) {
    conditions.push(["page_address", "ilike", `%${escapeLikeTerm(trimmed)}%`]);
  }

  assertFilterConditionBudget(scopeFilter.conditionCount + conditions.length);

  const expressions: unknown[] = [];
  for (const condition of [...scopeFilter.clauses, ...conditions]) {
    pushAnd(expressions, condition);
  }
  return expressions;
}

function mapPageItem(item: RelevantPagesItem) {
  const url = item.page_address ?? null;
  if (!url) return null;
  const organic = item.metrics?.organic ?? null;
  const traffic = organic?.etv ?? null;
  const keywords = organic?.count ?? null;
  return {
    page: url,
    relativePath: toRelativePath(url),
    organicTraffic: traffic != null ? Math.round(traffic) : null,
    keywords: keywords != null ? Math.round(keywords) : null,
  };
}

export async function getPagesPage(
  input: {
    projectId: string;
    domain: string;
    scope?: ResearchScope;
    locationCode: number;
    languageCode: string;
    page: number;
    pageSize: number;
    sortMode: DomainPagesSortMode;
    sortOrder: DomainPagesSortOrder;
    filters: DomainKeywordsFilters;
    search?: string;
  },
  billingCustomer: BillingCustomerContext,
): Promise<DomainPagesPageResult> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);
  const ownSite = await loadOwnSiteData({
    ...input,
    organizationId: billingCustomer.organizationId,
    target,
  });
  if (ownSite) return ownSitePagesPage(ownSite, input, target.hostname);

  const scopeFilter = buildRelevantPagesScopeFilter(target);
  const offset = (input.page - 1) * input.pageSize;
  const orderBy = [`${SORT_FIELD_BY_MODE[input.sortMode]},${input.sortOrder}`];
  const filters = buildPageFilters(input.filters, input.search, scopeFilter);

  const cacheKey = await buildCacheKey("domain:pages-page", {
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
  const cached = domainPagesPageResultSchema.safeParse(cachedRaw);
  if (cached.success) {
    return cached.data;
  }

  const dataforseo = createDataforseoClient(billingCustomer);
  const response = await dataforseo.domain.relevantPages({
    target: target.hostname,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    limit: input.pageSize,
    offset,
    orderBy,
    filters: filters.length > 0 ? filters : undefined,
  });

  const pages = response.items
    .map(mapPageItem)
    .filter(
      (item): item is NonNullable<ReturnType<typeof mapPageItem>> =>
        item != null,
    );

  const totalCount = response.totalCount;
  const hasMore = computeHasMore(
    offset,
    response.items.length,
    totalCount,
    input.pageSize,
  );

  const result: DomainPagesPageResult = {
    domain: target.hostname,
    page: input.page,
    pageSize: input.pageSize,
    totalCount,
    hasMore,
    pages,
    fetchedAt: new Date().toISOString(),
  };

  // waitUntil, not void: workerd cancels unregistered pending I/O once the
  // response is sent, so a fire-and-forget put never persists the cache.
  waitUntil(
    setCached(cacheKey, result, DOMAIN_PAGES_PAGE_TTL_SECONDS).catch(
      (error) => {
        console.error("domain.pages-page.cache-write failed:", error);
      },
    ),
  );

  return result;
}
