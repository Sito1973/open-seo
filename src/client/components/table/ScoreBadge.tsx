import {
  DIFFICULTY_ESTIMATE_LABEL,
  isEstimatedDifficulty,
  shownDifficulty,
} from "@/shared/keyword-difficulty";

function scoreTierClass(value: number | null): string {
  if (value == null) return "score-tier-na";
  if (value <= 20) return "score-tier-1";
  if (value <= 35) return "score-tier-2";
  if (value <= 50) return "score-tier-3";
  if (value <= 65) return "score-tier-4";
  if (value <= 80) return "score-tier-5";
  return "score-tier-6";
}

/** Keyword difficulty (0-100) as a tier-colored badge. */
export function ScoreBadge({
  value,
  estimated = false,
}: {
  value: number | null;
  /** OpenSEO's own estimate: dashed outline and a label on hover. */
  estimated?: boolean;
}) {
  return (
    <span
      className={`score-badge ${scoreTierClass(value)} inline-flex size-6 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums${estimated ? " outline-1 outline-offset-1 outline-dashed outline-current" : ""}`}
      title={
        estimated
          ? `${DIFFICULTY_ESTIMATE_LABEL} from a Google page this server saved (local pack reviews and, with Open PageRank, the top 10's authority), not DataForSEO data`
          : undefined
      }
    >
      {value ?? "-"}
    </span>
  );
}

/** A row's keyword difficulty: the provider's, else OpenSEO's estimate. */
export function DifficultyBadge({
  row,
}: {
  row: Parameters<typeof shownDifficulty>[0];
}) {
  return (
    <ScoreBadge
      value={shownDifficulty(row)}
      estimated={isEstimatedDifficulty(row)}
    />
  );
}
