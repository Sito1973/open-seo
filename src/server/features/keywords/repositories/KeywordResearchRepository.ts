import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  keywordDifficultyEstimates,
  keywordMetrics,
  savedKeywordTagAssignments,
  savedKeywords,
} from "@/db/schema";
import {
  SavedKeywordTagsRepository,
  type SavedKeywordTagRecord,
} from "./SavedKeywordTagsRepository";

type SavedKeywordRecord = typeof savedKeywords.$inferSelect;
type KeywordMetricRecord = typeof keywordMetrics.$inferSelect;
type SavedKeywordsListParams = {
  projectId: string;
  search?: string;
  includeTerms?: string[];
  excludeTerms?: string[];
  minVolume?: number | null;
  maxVolume?: number | null;
  minCpc?: number | null;
  maxCpc?: number | null;
  minDifficulty?: number | null;
  maxDifficulty?: number | null;
  tagIds?: string[];
  tagNames?: string[];
  page?: number;
  pageSize?: number;
  sort?: SavedKeywordSortField;
  order?: "asc" | "desc";
};

type SavedKeywordSortField =
  | "createdAt"
  | "keyword"
  | "searchVolume"
  | "cpc"
  | "competition"
  | "keywordDifficulty"
  | "fetchedAt";

type SavedKeywordListRow = {
  row: SavedKeywordRecord;
  metric: KeywordMetricRecord | null;
  /** OpenSEO's stored difficulty estimate for the keyword, if any. */
  difficultyEstimate: number | null;
  tags: SavedKeywordTagRecord[];
};

// The difficulty filters and sorting use: the provider's, else OpenSEO's
// estimate, as the saved keywords table shows it. Estimates live in their own
// table (see keywordDifficultyEstimates), joined on read.
const shownDifficulty = sql<
  number | null
>`coalesce(${keywordMetrics.keywordDifficulty}, ${keywordDifficultyEstimates.keywordDifficulty})`;

async function upsertKeywordMetric(params: {
  projectId: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
  searchVolume: number | null;
  cpc: number | null;
  competition: number | null;
  keywordDifficulty: number | null;
  intent: string | null;
  monthlySearchesJson: string;
}) {
  const fetchedAt = new Date().toISOString();

  await db
    .insert(keywordMetrics)
    .values({
      projectId: params.projectId,
      keyword: params.keyword,
      locationCode: params.locationCode,
      languageCode: params.languageCode,
      searchVolume: params.searchVolume,
      cpc: params.cpc,
      competition: params.competition,
      keywordDifficulty: params.keywordDifficulty,
      intent: params.intent,
      monthlySearches: params.monthlySearchesJson,
      fetchedAt,
    })
    .onConflictDoUpdate({
      target: [
        keywordMetrics.projectId,
        keywordMetrics.keyword,
        keywordMetrics.locationCode,
        keywordMetrics.languageCode,
      ],
      set: {
        searchVolume: params.searchVolume,
        cpc: params.cpc,
        competition: params.competition,
        keywordDifficulty: params.keywordDifficulty,
        intent: params.intent,
        monthlySearches: params.monthlySearchesJson,
        fetchedAt,
      },
    });
}

/** Every stored metric of one project market: volume, CPC and difficulty. */
async function listKeywordMetricsForMarket(params: {
  projectId: string;
  locationCode: number;
  languageCode: string;
}) {
  return db
    .select({
      keyword: keywordMetrics.keyword,
      searchVolume: keywordMetrics.searchVolume,
      cpc: keywordMetrics.cpc,
      keywordDifficulty: keywordMetrics.keywordDifficulty,
    })
    .from(keywordMetrics)
    .where(
      and(
        eq(keywordMetrics.projectId, params.projectId),
        eq(keywordMetrics.locationCode, params.locationCode),
        eq(keywordMetrics.languageCode, params.languageCode),
      ),
    );
}

async function countSavedKeywords(projectId: string) {
  const [result] = await db
    .select({ value: count() })
    .from(savedKeywords)
    .where(eq(savedKeywords.projectId, projectId));
  return result?.value ?? 0;
}

async function saveKeywordsToProject(params: {
  projectId: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
}): Promise<SavedKeywordRecord[]> {
  if (params.keywords.length === 0) return [];

  await runBatch((tx) =>
    params.keywords.map((keyword) =>
      tx
        .insert(savedKeywords)
        .values({
          id: crypto.randomUUID(),
          projectId: params.projectId,
          keyword,
          locationCode: params.locationCode,
          languageCode: params.languageCode,
        })
        .onConflictDoNothing(),
    ),
  );

  return listSavedKeywordRowsByKeywords(params);
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function buildSavedKeywordWhere(params: {
  projectId: string;
  search?: string;
  includeTerms?: string[];
  excludeTerms?: string[];
  minVolume?: number | null;
  maxVolume?: number | null;
  minCpc?: number | null;
  maxCpc?: number | null;
  minDifficulty?: number | null;
  maxDifficulty?: number | null;
  tagIds?: string[];
}) {
  const clauses: SQL[] = [eq(savedKeywords.projectId, params.projectId)];
  const search = params.search?.trim();
  if (search) {
    clauses.push(
      sql`lower(${savedKeywords.keyword}) like ${`%${escapeLike(search.toLocaleLowerCase())}%`} escape '\\'`,
    );
  }
  for (const term of params.includeTerms ?? []) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    clauses.push(
      sql`lower(${savedKeywords.keyword}) like ${`%${escapeLike(trimmed.toLocaleLowerCase())}%`} escape '\\'`,
    );
  }
  for (const term of params.excludeTerms ?? []) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    clauses.push(
      sql`lower(${savedKeywords.keyword}) not like ${`%${escapeLike(trimmed.toLocaleLowerCase())}%`} escape '\\'`,
    );
  }
  if (params.minVolume != null) {
    clauses.push(gte(keywordMetrics.searchVolume, params.minVolume));
  }
  if (params.maxVolume != null) {
    clauses.push(lte(keywordMetrics.searchVolume, params.maxVolume));
  }
  if (params.minCpc != null) {
    clauses.push(gte(keywordMetrics.cpc, params.minCpc));
  }
  if (params.maxCpc != null) {
    clauses.push(lte(keywordMetrics.cpc, params.maxCpc));
  }
  if (params.minDifficulty != null) {
    clauses.push(gte(shownDifficulty, params.minDifficulty));
  }
  if (params.maxDifficulty != null) {
    clauses.push(lte(shownDifficulty, params.maxDifficulty));
  }
  if (params.tagIds && params.tagIds.length > 0) {
    clauses.push(
      sql`exists (
        select 1
        from ${savedKeywordTagAssignments}
        where ${savedKeywordTagAssignments.savedKeywordId} = ${savedKeywords.id}
        and ${inArray(savedKeywordTagAssignments.tagId, params.tagIds)}
      )`,
    );
  }
  return and(...clauses);
}

function buildSavedKeywordOrderBy(
  sort: SavedKeywordSortField = "createdAt",
  order: "asc" | "desc" = "desc",
) {
  const direction = order === "asc" ? asc : desc;
  switch (sort) {
    case "keyword":
      return direction(savedKeywords.keyword);
    case "searchVolume":
      return direction(keywordMetrics.searchVolume);
    case "cpc":
      return direction(keywordMetrics.cpc);
    case "competition":
      return direction(keywordMetrics.competition);
    case "keywordDifficulty":
      return direction(shownDifficulty);
    case "fetchedAt":
      return direction(keywordMetrics.fetchedAt);
    case "createdAt":
    default:
      return direction(savedKeywords.createdAt);
  }
}

async function listSavedKeywordsByProject(
  params: SavedKeywordsListParams,
): Promise<{
  rows: SavedKeywordListRow[];
  totalCount: number;
  tags: (SavedKeywordTagRecord & { keywordCount: number })[];
}> {
  const [{ tagIds, emptyTagNameMatch }, tags] = await Promise.all([
    SavedKeywordTagsRepository.getTagFilterIds(params),
    SavedKeywordTagsRepository.listSavedKeywordTagsByProject(params.projectId),
  ]);

  if (emptyTagNameMatch) {
    return { rows: [], totalCount: 0, tags };
  }

  const where = buildSavedKeywordWhere({
    projectId: params.projectId,
    search: params.search,
    includeTerms: params.includeTerms,
    excludeTerms: params.excludeTerms,
    minVolume: params.minVolume,
    maxVolume: params.maxVolume,
    minCpc: params.minCpc,
    maxCpc: params.maxCpc,
    minDifficulty: params.minDifficulty,
    maxDifficulty: params.maxDifficulty,
    tagIds,
  });

  const metricJoin = and(
    eq(keywordMetrics.keyword, savedKeywords.keyword),
    eq(keywordMetrics.projectId, savedKeywords.projectId),
    eq(keywordMetrics.locationCode, savedKeywords.locationCode),
    eq(keywordMetrics.languageCode, savedKeywords.languageCode),
  );

  const estimateJoin = and(
    eq(keywordDifficultyEstimates.keyword, savedKeywords.keyword),
    eq(keywordDifficultyEstimates.projectId, savedKeywords.projectId),
    eq(keywordDifficultyEstimates.locationCode, savedKeywords.locationCode),
    eq(keywordDifficultyEstimates.languageCode, savedKeywords.languageCode),
  );

  const [{ value: totalCount } = { value: 0 }] = await db
    .select({ value: count() })
    .from(savedKeywords)
    .leftJoin(keywordMetrics, metricJoin)
    .leftJoin(keywordDifficultyEstimates, estimateJoin)
    .where(where);

  const baseQuery = db
    .select({
      row: savedKeywords,
      metric: keywordMetrics,
      difficultyEstimate: keywordDifficultyEstimates.keywordDifficulty,
    })
    .from(savedKeywords)
    .leftJoin(keywordMetrics, metricJoin)
    .leftJoin(keywordDifficultyEstimates, estimateJoin)
    .where(where)
    .orderBy(
      buildSavedKeywordOrderBy(params.sort, params.order),
      asc(savedKeywords.id),
    );

  const rows =
    params.pageSize == null
      ? await baseQuery
      : await baseQuery
          .limit(params.pageSize)
          .offset(((params.page ?? 1) - 1) * params.pageSize);
  const tagsByKeywordId =
    await SavedKeywordTagsRepository.listTagsBySavedKeywordIds(
      params.projectId,
      rows.map(({ row }) => row.id),
    );

  return {
    totalCount,
    tags,
    rows: rows.map(({ row, metric, difficultyEstimate }) => ({
      row,
      metric,
      difficultyEstimate,
      tags: tagsByKeywordId.get(row.id) ?? [],
    })),
  };
}

async function listSavedKeywordRowsByKeywords(params: {
  projectId: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
}) {
  const rows: SavedKeywordRecord[] = [];
  for (let i = 0; i < params.keywords.length; i += QUERY_CHUNK_SIZE) {
    const chunk = params.keywords.slice(i, i + QUERY_CHUNK_SIZE);
    rows.push(
      ...(await db
        .select()
        .from(savedKeywords)
        .where(
          and(
            eq(savedKeywords.projectId, params.projectId),
            eq(savedKeywords.locationCode, params.locationCode),
            eq(savedKeywords.languageCode, params.languageCode),
            inArray(savedKeywords.keyword, chunk),
          ),
        )),
    );
  }
  return rows;
}

// D1 caps bound parameters at 100 per statement; leave headroom for the
// projectId filter.
const QUERY_CHUNK_SIZE = 80;
const DELETE_CHUNK_SIZE = 90;

async function removeSavedKeywords(
  savedKeywordIds: string[],
  projectId: string,
) {
  let deletedCount = 0;
  for (let i = 0; i < savedKeywordIds.length; i += DELETE_CHUNK_SIZE) {
    const chunk = savedKeywordIds.slice(i, i + DELETE_CHUNK_SIZE);
    const deleted = await db
      .delete(savedKeywords)
      .where(
        and(
          inArray(savedKeywords.id, chunk),
          eq(savedKeywords.projectId, projectId),
        ),
      )
      .returning({ id: savedKeywords.id });
    deletedCount += deleted.length;
  }
  return deletedCount;
}

export const KeywordResearchRepository = {
  upsertKeywordMetric,
  listKeywordMetricsForMarket,
  countSavedKeywords,
  saveKeywordsToProject,
  listSavedKeywordsByProject,
  addTagsToSavedKeywords: SavedKeywordTagsRepository.addTagsToSavedKeywords,
  replaceTagsForSavedKeywords:
    SavedKeywordTagsRepository.replaceTagsForSavedKeywords,
  removeTagsFromSavedKeywords:
    SavedKeywordTagsRepository.removeTagsFromSavedKeywords,
  removeAllTagsFromSavedKeywords:
    SavedKeywordTagsRepository.removeAllTagsFromSavedKeywords,
  updateSavedKeywordTag: SavedKeywordTagsRepository.updateSavedKeywordTag,
  deleteSavedKeywordTag: SavedKeywordTagsRepository.deleteSavedKeywordTag,
  removeSavedKeywords,
} as const;
