import { waitUntil } from "cloudflare:workers";
import { sort } from "remeda";
import { z } from "zod";
import { hasGoogleOAuthConfig } from "@/server/features/google/oauth-config";
import {
  GscConnectionRepository,
  type GscConnection,
} from "@/server/features/gsc/repositories/GscConnectionRepository";
import {
  GscService,
  isExpectedGrantFailure,
} from "@/server/features/gsc/services/GscService";
import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import { toRelativePath } from "@/server/lib/domainUtils";
import { AppError } from "@/server/lib/errors";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import { usesGoogleFallbacks } from "@/server/lib/runtime-env";
import type { ResearchTarget } from "@/shared/researchScope";

/** A site's Search Console data is refreshed every 12 hours. */
const SITE_TTL_SECONDS = 12 * 60 * 60;
// Google's maximum per request. A restaurant site has a small fraction of it.
const SITE_ROW_LIMIT = 25_000;

const siteDataSchema = z.object({
  siteUrl: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  queryPages: z.array(
    z.object({
      query: z.string(),
      page: z.string(),
      clicks: z.number(),
      impressions: z.number(),
      position: z.number(),
    }),
  ),
  pages: z.array(
    z.object({
      page: z.string(),
      clicks: z.number(),
      impressions: z.number(),
    }),
  ),
});

type SiteData = z.infer<typeof siteDataSchema>;

export type SearchConsoleSource = {
  /** The connected property that covers the target, or null when none does. */
  siteUrl: string | null;
  startDate: string | null;
  endDate: string | null;
  /** The organization's connected properties, to explain an uncovered target. */
  connectedSites: string[];
};

type OwnSiteKeyword = {
  keyword: string;
  /** Average position, weighted by impressions. */
  position: number | null;
  clicks: number;
  impressions: number;
  /** The page with the most impressions for the query. */
  url: string;
  relativeUrl: string | null;
  // From the project's stored keyword metrics for the market, when any.
  searchVolume: number | null;
  cpc: number | null;
  keywordDifficulty: number | null;
};

type OwnSitePage = {
  page: string;
  relativePath: string | null;
  clicks: number;
  impressions: number;
  /** Queries Search Console lists for the page. */
  keywords: number;
};

export type OwnSiteData = {
  source: SearchConsoleSource;
  /** Queries in the target's scope, most impressions first. */
  keywords: OwnSiteKeyword[];
  /** Pages in the target's scope, most clicks first. */
  pages: OwnSitePage[];
};

/**
 * Domain research for the organization's own sites from Google Search
 * Console, on a self-hosted install that does not use DataForSEO for it.
 * Null when DataForSEO serves domain research (hosted, or a key for every
 * API) or Search Console is not set up, so the caller keeps its DataForSEO
 * path. Otherwise the target is served from the connected property that
 * covers it, preferring the current project's; a target no property covers
 * gets empty rows, since this server has no other source for it.
 *
 * Clicks are real, but Search Console leaves out anonymized queries, so
 * keyword counts are a minimum. Page clicks include those queries.
 */
export async function loadOwnSiteData(input: {
  organizationId: string;
  projectId: string;
  target: ResearchTarget;
  locationCode: number;
  languageCode: string;
}): Promise<OwnSiteData | null> {
  if (!(await usesGoogleFallbacks())) return null;
  if (!(await hasGoogleOAuthConfig())) return null;

  const connections = await GscConnectionRepository.listByOrganization(
    input.organizationId,
  );
  const covering = connections.filter((connection) =>
    propertyCovers(connection.siteUrl, input.target.hostname),
  );
  const connection =
    covering.find((candidate) => candidate.projectId === input.projectId) ??
    covering[0];
  const connectedSites = [...new Set(connections.map((c) => c.siteUrl))];
  if (!connection) {
    return {
      source: { siteUrl: null, startDate: null, endDate: null, connectedSites },
      keywords: [],
      pages: [],
    };
  }

  const [site, metrics] = await Promise.all([
    loadSite(input.organizationId, connection),
    KeywordResearchRepository.listKeywordMetricsForMarket(input),
  ]);
  const metricsByKeyword = new Map(
    metrics.map((metric) => [metric.keyword.toLowerCase(), metric]),
  );

  const inScope = site.queryPages.filter((row) =>
    pageInScope(row.page, input.target),
  );
  const byQuery = new Map<
    string,
    {
      clicks: number;
      impressions: number;
      positionSum: number;
      url: string;
      urlImpressions: number;
    }
  >();
  const keywordsByPage = new Map<string, number>();
  for (const row of inScope) {
    keywordsByPage.set(row.page, (keywordsByPage.get(row.page) ?? 0) + 1);
    const entry = byQuery.get(row.query) ?? {
      clicks: 0,
      impressions: 0,
      positionSum: 0,
      url: row.page,
      urlImpressions: -1,
    };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.positionSum += row.position * row.impressions;
    if (row.impressions > entry.urlImpressions) {
      entry.url = row.page;
      entry.urlImpressions = row.impressions;
    }
    byQuery.set(row.query, entry);
  }

  const keywords = sort(
    [...byQuery].map(([keyword, entry]): OwnSiteKeyword => {
      const metric = metricsByKeyword.get(keyword.toLowerCase());
      return {
        keyword,
        position:
          entry.impressions > 0
            ? Math.round((entry.positionSum / entry.impressions) * 10) / 10
            : null,
        clicks: entry.clicks,
        impressions: entry.impressions,
        url: entry.url,
        relativeUrl: toRelativePath(entry.url),
        searchVolume: metric?.searchVolume ?? null,
        cpc: metric?.cpc ?? null,
        keywordDifficulty: metric?.keywordDifficulty ?? null,
      };
    }),
    (a, b) => b.impressions - a.impressions || b.clicks - a.clicks,
  );

  const pages = sort(
    site.pages
      .filter((row) => pageInScope(row.page, input.target))
      .map(
        (row): OwnSitePage => ({
          page: row.page,
          relativePath: toRelativePath(row.page),
          clicks: row.clicks,
          impressions: row.impressions,
          keywords: keywordsByPage.get(row.page) ?? 0,
        }),
      ),
    (a, b) => b.clicks - a.clicks || b.impressions - a.impressions,
  );

  return {
    source: {
      siteUrl: site.siteUrl,
      startDate: site.startDate,
      endDate: site.endDate,
      connectedSites,
    },
    keywords,
    pages,
  };
}

/** Plain-text provenance for MCP tool output. */
export function searchConsoleNote(
  source: SearchConsoleSource,
  target: string,
): string {
  if (!source.siteUrl) {
    const sites =
      source.connectedSites.length > 0
        ? source.connectedSites.join(", ")
        : "none yet";
    return `No Search Console data for ${target}. This server has no DataForSEO for domain research, so it reads it from Google Search Console and covers only the sites connected to a project in this organization (connected: ${sites}). Connect the property under the project's Settings → Integrations.`;
  }
  return `Source: Google Search Console property ${source.siteUrl}, ${source.startDate} to ${source.endDate}, all countries. Traffic is real clicks, position is the average position weighted by impressions, and Search Console leaves out anonymized queries, so keyword counts are a minimum. No credits used.`;
}

/**
 * A domain property (`sc-domain:example.com`) covers the domain and all its
 * subdomains; a URL-prefix property covers only its own host, with or
 * without `www.` (target hostnames have it stripped).
 */
function propertyCovers(siteUrl: string, hostname: string): boolean {
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length).toLowerCase();
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }
  return hostOf(siteUrl) === hostname;
}

/** Same rules as the DataForSEO scope filters in researchScopeFilters.ts. */
function pageInScope(page: string, target: ResearchTarget): boolean {
  let url: URL;
  try {
    url = new URL(page);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (target.scope === "subdomains") {
    return host === target.hostname || host.endsWith(`.${target.hostname}`);
  }
  if (host !== target.hostname) return false;
  const path = url.pathname.replace(/\/+$/, "");
  switch (target.scope) {
    case "domain":
      return true;
    case "exact_url":
      return path === target.path;
    case "subfolder":
      return path === target.path || path.startsWith(`${target.path}/`);
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** One `[query, page]` and one `[page]` report of the last 28 days. Page
 *  rows carry the clicks of anonymized queries too. */
async function loadSite(
  organizationId: string,
  connection: GscConnection,
): Promise<SiteData> {
  const cacheKey = await buildCacheKey("domain:gsc-site", {
    organizationId,
    siteUrl: connection.siteUrl,
  });
  const cached = siteDataSchema.safeParse(await getCached(cacheKey));
  if (cached.success) return cached.data;

  const report = (dimensions: Array<"query" | "page">) =>
    GscService.getPerformance({
      projectId: connection.projectId,
      dimensions,
      dateRange: "last_28_days",
      rowLimit: SITE_ROW_LIMIT,
    });
  let queryPages;
  let pages;
  try {
    [queryPages, pages] = await Promise.all([
      report(["query", "page"]),
      report(["page"]),
    ]);
  } catch (error) {
    if (isExpectedGrantFailure(error)) {
      throw new AppError(
        "FORBIDDEN",
        `Google rejected the saved Search Console access for ${connection.siteUrl}. Reconnect Search Console under the project's Settings → Integrations.`,
      );
    }
    throw error;
  }

  const site: SiteData = {
    siteUrl: connection.siteUrl,
    startDate: queryPages.request.startDate,
    endDate: queryPages.request.endDate,
    queryPages: queryPages.rows.flatMap((row) => {
      const [query, page] = row.keys ?? [];
      return query && page
        ? [
            {
              query,
              page,
              clicks: row.clicks,
              impressions: row.impressions,
              position: row.position,
            },
          ]
        : [];
    }),
    pages: pages.rows.flatMap((row) => {
      const [page] = row.keys ?? [];
      return page
        ? [{ page, clicks: row.clicks, impressions: row.impressions }]
        : [];
    }),
  };
  // waitUntil, not void: workerd cancels unregistered pending I/O once the
  // response is sent, so a fire-and-forget put never persists the cache.
  waitUntil(
    setCached(cacheKey, site, SITE_TTL_SECONDS).catch((error) => {
      console.error("domain.gsc-site.cache-write failed:", error);
    }),
  );
  return site;
}
