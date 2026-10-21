import {
  AlertTriangle,
  Monitor,
  Plus,
  Settings,
  Smartphone,
} from "lucide-react";
import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import { Button } from "@/client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import { LOCATIONS } from "@/client/features/keywords/locations";
import {
  devicesLabel,
  formatRequestRange,
  scheduleLabel,
} from "@/shared/rank-tracking";
import { formatNextCheck } from "./scheduleTime";
import { formatLocationLabel } from "@/shared/keyword-locations";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import {
  comparePeriodSchema,
  type ComparePeriod,
} from "@/types/schemas/rank-tracking-search";

const COMPARE_ITEMS: { value: ComparePeriod; label: string }[] = [
  { value: "1d", label: "vs yesterday" },
  { value: "7d", label: "vs last week" },
  { value: "30d", label: "vs last month" },
  { value: "90d", label: "vs 90 days ago" },
];

export function RankTrackingDetailHeader({
  config,
  run,
  costEstimate,
  hasBothDevices,
  activeDevice,
  onActiveDeviceChange,
  comparePeriod,
  onComparePeriodChange,
  onEdit,
  onToggleAddKeywords,
}: {
  config: RankTrackingConfig;
  run: { lastCheckedAt: string | null } | null | undefined;
  costEstimate:
    | {
        keywordCount: number;
        costUsd: number;
        brightData?: {
          minRequests: number;
          maxRequests: number;
          remaining: number;
          monthlyBudget: number;
          warning: string | null;
        };
      }
    | undefined;
  hasBothDevices: boolean;
  activeDevice: "desktop" | "mobile";
  onActiveDeviceChange: (v: "desktop" | "mobile") => void;
  comparePeriod: ComparePeriod;
  onComparePeriodChange: (v: ComparePeriod) => void;
  onEdit: () => void;
  onToggleAddKeywords: () => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 px-4 pt-4 pb-3">
      <div>
        <h2 className="text-lg font-semibold">{config.domain}</h2>
        <p className="text-xs text-muted-foreground">
          {config.locationName
            ? formatLocationLabel(config.locationName, 2)
            : (LOCATIONS[config.locationCode] ?? "US")}{" "}
          &middot; {devicesLabel(config.devices)} &middot;{" "}
          {scheduleLabel(config.scheduleInterval)}
          {config.scheduleInterval !== "manual" && config.nextCheckAt && (
            <> &middot; Next: {formatNextCheck(config.nextCheckAt)}</>
          )}
          {run?.lastCheckedAt && (
            <>
              {" "}
              &middot; Last: {new Date(run.lastCheckedAt).toLocaleDateString()}
            </>
          )}
          {costEstimate && costEstimate.keywordCount > 0 && (
            <>
              {" "}
              &middot;{" "}
              {costEstimate.brightData ? (
                <BrightDataCost {...costEstimate.brightData} />
              ) : (
                <>~${costEstimate.costUsd.toFixed(2)}/check</>
              )}
            </>
          )}
        </p>
        {costEstimate?.brightData?.warning && (
          <p className="mt-1 flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {costEstimate.brightData.warning}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {hasBothDevices && (
          <SegmentedToggle
            items={[
              {
                value: "desktop" as const,
                icon: <Monitor className="size-3.5" />,
                label: "Desktop",
              },
              {
                value: "mobile" as const,
                icon: <Smartphone className="size-3.5" />,
                label: "Mobile",
              },
            ]}
            value={activeDevice}
            onChange={onActiveDeviceChange}
          />
        )}
        <Select
          items={COMPARE_ITEMS}
          value={comparePeriod}
          onValueChange={(value) => {
            const parsed = comparePeriodSchema.safeParse(value);
            if (parsed.success) onComparePeriodChange(parsed.data);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="Comparison period"
            title="Comparison period"
            className="text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMPARE_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="hidden h-6 w-px bg-border sm:block" />
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Settings data-icon="inline-start" />
          Configure
        </Button>
        <Button size="sm" onClick={onToggleAddKeywords}>
          <Plus data-icon="inline-start" />
          Add Keywords
        </Button>
      </div>
    </div>
  );
}

function BrightDataCost({
  minRequests,
  maxRequests,
  remaining,
  monthlyBudget,
}: {
  minRequests: number;
  maxRequests: number;
  remaining: number;
  monthlyBudget: number;
}) {
  return (
    <span title="Each keyword and device sends one Bright Data request per page of 10 results, stopping at the page where the domain appears.">
      {formatRequestRange(minRequests, maxRequests)} Bright Data requests/check
      &middot; {remaining.toLocaleString("en-US")} of{" "}
      {monthlyBudget.toLocaleString("en-US")} left this month
    </span>
  );
}
