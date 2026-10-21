// Keyword difficulty comes from DataForSEO when the server has it. On a
// self-hosted install where Bright Data stands in, OpenSEO estimates it from
// a saved Google page instead (features/serp/services/difficultyEstimate.ts).
// Rows carry the two apart, so an estimate is labeled wherever it shows and is
// never saved as provider data.

/** How the app and the MCP tools name OpenSEO's own estimates. */
export const DIFFICULTY_ESTIMATE_LABEL = "OpenSEO estimate";

type DifficultyRow = {
  keywordDifficulty: number | null;
  /** OpenSEO's estimate (0-100), when one is stored for the keyword. */
  keywordDifficultyEstimate?: number | null;
};

/** The difficulty a row shows: the provider's, else OpenSEO's estimate. */
export function shownDifficulty(row: DifficultyRow): number | null {
  return row.keywordDifficulty ?? row.keywordDifficultyEstimate ?? null;
}

/** Whether the difficulty a row shows is OpenSEO's estimate. */
export function isEstimatedDifficulty(row: DifficultyRow): boolean {
  return row.keywordDifficulty == null && row.keywordDifficultyEstimate != null;
}

/** An MCP table cell: the provider's difficulty, or "~N" for an estimate. */
export function difficultyCell(row: DifficultyRow): number | string | null {
  return isEstimatedDifficulty(row)
    ? `~${row.keywordDifficultyEstimate}`
    : row.keywordDifficulty;
}

/** The note under an MCP table with any "~N" difficulty cell. */
export const DIFFICULTY_ESTIMATE_NOTE = `KD "~N" is an ${DIFFICULTY_ESTIMATE_LABEL} (keywordDifficultyEstimate) from a Google page this server saved, not DataForSEO data; estimate_keyword_difficulty explains it and estimates more keywords.`;
