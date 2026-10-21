import { sortBy } from "remeda";
import {
  GscNotConnectedError,
  GscService,
} from "@/server/features/gsc/services/GscService";
import type { ResolvedResearchKeywordsInput } from "@/types/schemas/keywords";
import { normalizeKeyword, type EnrichedKeyword } from "./helpers";
import { loadIntentRules, ruleIntent } from "./intent";

// Enough of the site's queries to pick the most seen ones: Search Console
// sorts by clicks.
const BRIDGE_QUERY_ROWS = 1_000;

/**
 * Until Google approves Basic access, the Keyword Planner answers
 * GOOGLE_ADS_ACCESS_PENDING. Keyword research then lists the project's own
 * Search Console queries of the last 28 days that contain the seed, most seen
 * first, with the site's impressions in their own field. Impressions are not
 * search volume, so volume stays null and the rows are neither cached nor
 * stored. Null when the project has no Search Console data for the seed, so
 * the caller reports the pending access instead.
 */
export async function searchConsoleBridge(
  input: ResolvedResearchKeywordsInput,
  seedKeyword: string,
): Promise<{
  rows: EnrichedKeyword[];
  source: "search_console";
  usedFallback: false;
} | null> {
  let queries;
  try {
    ({ rows: queries } = await GscService.getPerformance({
      projectId: input.projectId,
      dimensions: ["query"],
      dateRange: "last_28_days",
      filters: [
        { dimension: "query", operator: "contains", expression: seedKeyword },
      ],
      rowLimit: BRIDGE_QUERY_ROWS,
    }));
  } catch (error) {
    if (!(error instanceof GscNotConnectedError)) {
      console.warn("keywords.research.search-console-bridge failed:", error);
    }
    return null;
  }
  if (queries.length === 0) return null;

  const rules = await loadIntentRules(input.projectId, input.languageCode);
  const rows = sortBy(queries, [(query) => query.impressions, "desc"])
    .slice(0, input.resultLimit)
    .flatMap((query): EnrichedKeyword[] => {
      const keyword = normalizeKeyword(query.keys?.[0] ?? "");
      if (!keyword) return [];
      return [
        {
          keyword,
          searchVolume: null,
          trend: [],
          cpc: null,
          competition: null,
          keywordDifficulty: null,
          intent: (rules && ruleIntent(rules, keyword)) ?? "unknown",
          gscImpressions: query.impressions,
        },
      ];
    });
  return { rows, source: "search_console", usedFallback: false };
}
