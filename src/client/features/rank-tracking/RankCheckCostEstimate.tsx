import { useQuery } from "@tanstack/react-query";
import { getRankCheckBudget } from "@/serverFunctions/rank-tracking";
import {
  type BrightDataBudget,
  devicesCount,
  estimateBrightDataRankCheckRequests,
  estimateRankCheckCredits,
  formatRequestRange,
} from "@/shared/rank-tracking";
import type { SaveConfigInput } from "./useSaveConfigMutations";

type EstimateInput = Pick<
  SaveConfigInput,
  "devices" | "serpDepth" | "schedule"
>;

/**
 * The tracker form's cost hint: DataForSEO's price, or Bright Data requests
 * against the monthly budget on a self-hosted server that checks ranks there.
 */
export function RankCheckCostEstimate({
  projectId,
  ...input
}: EstimateInput & { projectId: string }) {
  const budgetQuery = useQuery({
    queryKey: ["rankCheckBudget", projectId],
    queryFn: () => getRankCheckBudget({ data: { projectId } }),
  });
  // Waits for the answer so a Bright Data server never flashes prices.
  if (budgetQuery.isPending) return null;
  return budgetQuery.data ? (
    <BrightDataRequestEstimate {...input} budget={budgetQuery.data} />
  ) : (
    <CostEstimate {...input} />
  );
}

function CostEstimate({ devices, serpDepth, schedule }: EstimateInput) {
  // Scheduled checks run through the cheaper task queue; manual configs only
  // ever pay the live price.
  const { costUsd: costPerKeyword } = estimateRankCheckCredits(
    ["plain keyword"],
    devices,
    serpDepth,
    schedule === "manual" ? "live" : "queued",
  );
  const checksPerMonth =
    schedule === "daily" ? 30 : schedule === "weekly" ? 4 : 1;
  return (
    <div className="space-y-0.5 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
      <div>
        <span className="font-mono font-semibold text-foreground">
          ~${costPerKeyword.toFixed(4)}
        </span>{" "}
        per keyword per check
      </div>
      {schedule !== "manual" && (
        <div>
          50 keywords would cost{" "}
          <span className="font-mono font-semibold text-foreground">
            ~${(costPerKeyword * 50 * checksPerMonth).toFixed(2)}
          </span>
          /month
        </div>
      )}
    </div>
  );
}

// Priced like CostEstimate, on a sample of 50 keywords.
function BrightDataRequestEstimate({
  devices,
  serpDepth,
  schedule,
  budget,
}: EstimateInput & { budget: BrightDataBudget }) {
  const perKeyword = devicesCount(devices);
  const sample = estimateBrightDataRankCheckRequests(
    50 * perKeyword,
    serpDepth,
    schedule === "manual" ? null : schedule,
    budget,
  );
  return (
    <div className="space-y-0.5 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
      <div>
        <span className="font-mono font-semibold text-foreground">
          {formatRequestRange(
            perKeyword,
            perKeyword * Math.ceil(serpDepth / 10),
          )}
        </span>{" "}
        Bright Data requests per keyword per check, fewer when the domain ranks
        on an early page
      </div>
      {sample.scheduled && (
        <div>
          50 keywords would use{" "}
          <span className="font-mono font-semibold text-foreground">
            {formatRequestRange(
              sample.scheduled.minRequestsPerMonth,
              sample.scheduled.maxRequestsPerMonth,
            )}
          </span>
          /month of this server&apos;s{" "}
          {budget.monthlyBudget.toLocaleString("en-US")} (
          {sample.remaining.toLocaleString("en-US")} left this month)
        </div>
      )}
      {sample.warning && (
        <div className="text-warning">At 50 keywords: {sample.warning}</div>
      )}
    </div>
  );
}
