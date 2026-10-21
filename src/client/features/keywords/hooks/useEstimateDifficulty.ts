import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import {
  estimateKeywordDifficulty,
  getKeywordDifficultyEstimateStatus,
} from "@/serverFunctions/keywords";

type EstimateResult = Awaited<ReturnType<typeof estimateKeywordDifficulty>>;

/** A selected keyword and its market (the project's when omitted). */
type SelectedKeyword = {
  keyword: string;
  locationCode?: number;
  languageCode?: string;
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

function summary(result: EstimateResult): string {
  const notes = [
    result.withoutEstimate.length > 0
      ? `${plural(result.withoutEstimate.length, "keyword")} without a local pack got no estimate${result.authorityUnavailable ? `: ${result.authorityUnavailable}` : "."}`
      : null,
    result.failed.length > 0
      ? `${plural(result.failed.length, "keyword")} failed: ${result.failed[0]?.error}`
      : null,
    result.notChecked.length > 0
      ? `${plural(result.notChecked.length, "keyword")} left for the next click (10 live searches each)`
      : null,
  ].filter((note) => note != null);
  return [
    `Estimated difficulty for ${plural(result.estimated, "keyword")} (${result.searchedLive} searched live).`,
    ...notes,
  ].join(" ");
}

/**
 * OpenSEO's keyword difficulty estimate as a bulk action, on self-hosted
 * servers where Bright Data stands in for DataForSEO. Hosted never asks.
 * `refreshKey` is the query whose rows show the new estimates: the server
 * joins them on read, so a refetch is all it takes.
 */
export function useEstimateDifficulty(projectId: string, refreshKey: QueryKey) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["keywordDifficultyEstimateStatus"],
    queryFn: () => getKeywordDifficultyEstimateStatus(),
    enabled: !isHostedClientAuthMode(),
    staleTime: Infinity,
  });
  // One market per request: rows in another market than the first one wait
  // for their own selection.
  const mutation = useMutation({
    mutationFn: (rows: SelectedKeyword[]) => {
      const [first] = rows;
      return estimateKeywordDifficulty({
        data: {
          projectId,
          keywords: rows
            .filter(
              (row) =>
                row.locationCode === first?.locationCode &&
                row.languageCode === first?.languageCode,
            )
            .map((row) => row.keyword)
            .slice(0, 50),
          locationCode: first?.locationCode,
          languageCode: first?.languageCode,
        },
      });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: refreshKey });
      const message = summary(result);
      if (result.estimated > 0) toast.success(message);
      else toast.warning(message);
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Difficulty estimate failed."),
      );
    },
  });
  return {
    available: status.data?.available === true,
    estimate: mutation.mutate,
    pending: mutation.isPending,
  };
}
