import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { DB_BATCH_SIZE, runBatch } from "@/db/runBatch";
import { keywordDifficultyEstimates } from "@/db/schema";
import { normalizeKeyword } from "@/server/features/keywords/services/research/helpers";

type EstimateRow = typeof keywordDifficultyEstimates.$inferInsert;

// D1 caps bound parameters at 100 per statement; leave headroom for the
// project and market filters.
const QUERY_CHUNK_SIZE = 80;

/** Saves estimates, replacing the project's earlier one for each keyword. */
async function upsert(rows: EstimateRow[]) {
  for (let i = 0; i < rows.length; i += DB_BATCH_SIZE) {
    const batch = rows.slice(i, i + DB_BATCH_SIZE);
    await runBatch((tx) =>
      batch.map((row) =>
        tx
          .insert(keywordDifficultyEstimates)
          .values(row)
          .onConflictDoUpdate({
            target: [
              keywordDifficultyEstimates.projectId,
              keywordDifficultyEstimates.keyword,
              keywordDifficultyEstimates.locationCode,
              keywordDifficultyEstimates.languageCode,
            ],
            set: {
              keywordDifficulty: row.keywordDifficulty,
              localScore: row.localScore,
              organicScore: row.organicScore,
              locationName: row.locationName,
              observedAt: row.observedAt,
              computedAt: row.computedAt,
            },
          }),
      ),
    );
  }
}

/**
 * The project's estimates for these keywords in one market, keyed by
 * normalized keyword. A keyword without one is missing.
 */
async function findForKeywords(input: {
  projectId: string;
  locationCode: number;
  languageCode: string;
  keywords: string[];
}) {
  const keywords = [...new Set(input.keywords.map(normalizeKeyword))];
  const byKeyword = new Map<
    string,
    typeof keywordDifficultyEstimates.$inferSelect
  >();
  for (let i = 0; i < keywords.length; i += QUERY_CHUNK_SIZE) {
    const rows = await db
      .select()
      .from(keywordDifficultyEstimates)
      .where(
        and(
          eq(keywordDifficultyEstimates.projectId, input.projectId),
          eq(keywordDifficultyEstimates.locationCode, input.locationCode),
          eq(keywordDifficultyEstimates.languageCode, input.languageCode),
          inArray(
            keywordDifficultyEstimates.keyword,
            keywords.slice(i, i + QUERY_CHUNK_SIZE),
          ),
        ),
      );
    for (const row of rows) byKeyword.set(row.keyword, row);
  }
  return byKeyword;
}

export const KeywordDifficultyEstimateRepository = { upsert, findForKeywords };
