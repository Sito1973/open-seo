import { filterSortPage } from "@/server/features/domain/services/filterSortPage";
import {
  loadOwnSiteData,
  searchConsoleNote,
  type OwnSiteData,
} from "@/server/features/domain/services/searchConsoleDomain";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import type { ResearchTarget } from "@/shared/researchScope";

type OwnSiteKeyword = OwnSiteData["keywords"][number];

const COLUMNS: McpTableColumn<OwnSiteKeyword>[] = [
  { header: "keyword", value: (row) => row.keyword },
  { header: "avg position", value: (row) => row.position },
  { header: "clicks", value: (row) => row.clicks },
  { header: "impressions", value: (row) => row.impressions },
  { header: "volume", value: (row) => row.searchVolume },
  { header: "url", value: (row) => row.url },
];

const SORT_FIELD = {
  rank: (row: OwnSiteKeyword) => row.position,
  search_volume: (row: OwnSiteKeyword) => row.searchVolume,
  traffic_estimate: (row: OwnSiteKeyword) => row.clicks,
  cpc: (row: OwnSiteKeyword) => row.cpc,
};

/**
 * get_ranked_keywords for the organization's own sites from Search Console,
 * on an install without DataForSEO for domain research. Null when DataForSEO
 * serves it, so the tool keeps its DataForSEO path.
 */
export async function rankedKeywordsFromSearchConsole(input: {
  organizationId: string;
  baseUrl: string;
  projectId: string;
  target: ResearchTarget;
  locationCode: number;
  languageCode: string;
  sortBy?: keyof typeof SORT_FIELD;
  minSearchVolume?: number;
  maxRank?: number;
  excludeBrandTerms?: string[];
  limit?: number;
  offset?: number;
}) {
  const ownSite = await loadOwnSiteData(input);
  if (!ownSite) return null;

  const sortBy = input.sortBy ?? "search_volume";
  const page = filterSortPage(
    ownSite.keywords,
    {
      terms: (row) => row.keyword,
      search: () => [],
      ranges: {
        Vol: (row) => row.searchVolume,
        Rank: (row) => row.position,
      },
    },
    {
      filters: {
        minVol: input.minSearchVolume,
        maxRank: input.maxRank,
        exclude: input.excludeBrandTerms?.join(","),
      },
      sortBy: SORT_FIELD[sortBy],
      sortOrder: sortBy === "rank" ? "asc" : "desc",
      offset: input.offset ?? 0,
      limit: input.limit ?? 50,
    },
  );

  const target = input.target;
  const targetLabel = `${target.display} (scope: ${target.scope})`;
  const rowsText =
    page.rows.length === 0
      ? `No Search Console queries for ${targetLabel}.`
      : `Found ${page.rows.length} Search Console queries for ${targetLabel} (of ${page.totalCount} total):\n${formatMcpTable(page.rows, COLUMNS)}`;
  return mcpResponse({
    text: `${searchConsoleNote(ownSite.source, target.display)}\n${rowsText}`,
    meta: buildProjectMeta(
      input,
      input.projectId,
      `/p/${input.projectId}/domain`,
      {
        domain: target.display,
        scope: target.scope,
      },
    ),
    structuredContent: {
      keywords: page.rows,
      totalCount: page.totalCount,
      target: target.display,
      scope: target.scope,
      dataSource: "gsc",
      searchConsole: ownSite.source,
    },
  });
}
