import type { GbpService } from "@/server/features/gbp/services/GbpService";
import { formatMcpTable, truncatedCell } from "@/server/mcp/table";

// Text renderers for the Google Business Profile tools. Full values stay in
// structuredContent; the text is what most clients hand the model.

type Locations = Awaited<ReturnType<typeof GbpService.listLocations>>;
type Reviews = Awaited<ReturnType<typeof GbpService.getReviews>>;
type Performance = Awaited<ReturnType<typeof GbpService.getPerformance>>;
type Keywords = Awaited<ReturnType<typeof GbpService.getSearchKeywords>>;

export const GBP_STORAGE_NOTE =
  "Business Profile API terms: keep review text, reviewer names, metric values and keyword lists in this chat; do not copy them into save_report or update_project_context. Reports may hold your own conclusions and recommendations.";

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export function formatLocationsText(result: Locations): string {
  const header = `${result.accountDisplayName} (${result.accountName}) · ${plural(result.locations.length, "location")}`;
  if (result.locations.length === 0) {
    return `${header}\nThis Business Profile account has no locations.`;
  }
  return [
    header,
    formatMcpTable(result.locations, [
      { header: "location", value: (row) => row.location },
      { header: "title", value: (row) => row.title },
      { header: "category", value: (row) => row.primaryCategory },
      { header: "address", value: (row) => row.address },
      { header: "status", value: (row) => row.status },
      { header: "placeId", value: (row) => row.placeId },
    ]),
    "Pass `location` to the other get_google_business_profile_* tools when the account has several. For get_local_rank_grid, use placeId as target.placeId, or target.name to match every branch.",
  ].join("\n");
}

export function formatReviewsText(
  result: Reviews,
  args: { orderBy: string; unansweredOnly: boolean },
): string {
  const average =
    result.averageRating === null
      ? "no rating yet"
      : `average ${result.averageRating.toFixed(1)}`;
  const lines = [
    `${result.title} (${result.location}) · ${average} from ${plural(result.totalReviewCount, "review")}`,
    `Showing ${plural(result.reviews.length, "review")} (${args.unansweredOnly ? "unanswered, " : ""}${args.orderBy}) · ${result.unansweredCount} of the ${result.fetchedCount} fetched have no owner reply`,
  ];
  if (result.reviews.length === 0) return lines.join("\n");
  return [
    ...lines,
    formatMcpTable(result.reviews, [
      { header: "rating", value: (row) => row.rating },
      { header: "created", value: (row) => row.createTime.slice(0, 10) },
      { header: "reviewer", value: (row) => row.reviewer ?? "anonymous" },
      {
        header: "replied",
        value: (row) => (row.reply ? "yes" : "no"),
      },
      {
        header: "comment",
        value: (row) => row.comment,
        format: truncatedCell(280),
      },
    ]),
  ].join("\n");
}

export function formatPerformanceText(result: Performance): string {
  const { totals } = result;
  const impressions =
    totals.impressionsMobileSearch +
    totals.impressionsDesktopSearch +
    totals.impressionsMobileMaps +
    totals.impressionsDesktopMaps;
  return [
    `${result.title} (${result.location}) · ${result.range.startDate}→${result.range.endDate}`,
    `Impressions ${impressions} (Search mobile ${totals.impressionsMobileSearch} · Search desktop ${totals.impressionsDesktopSearch} · Maps mobile ${totals.impressionsMobileMaps} · Maps desktop ${totals.impressionsDesktopMaps})`,
    `Directions ${totals.directionRequests} · Calls ${totals.callClicks} · Website ${totals.websiteClicks} · Messaging ${totals.messagingClicks} · Bookings ${totals.bookings} · Menu ${totals.foodMenuClicks}`,
    formatMcpTable(result.daily, [
      { header: "date", value: (row) => row.date },
      {
        header: "impressions",
        value: (row) =>
          row.impressionsMobileSearch +
          row.impressionsDesktopSearch +
          row.impressionsMobileMaps +
          row.impressionsDesktopMaps,
      },
      { header: "directions", value: (row) => row.directionRequests },
      { header: "calls", value: (row) => row.callClicks },
      { header: "website", value: (row) => row.websiteClicks },
      { header: "messaging", value: (row) => row.messagingClicks },
      { header: "bookings", value: (row) => row.bookings },
      { header: "menu", value: (row) => row.foodMenuClicks },
    ]),
  ].join("\n");
}

export function formatKeywordsText(result: Keywords): string {
  const header = `${result.title} (${result.location}) · search terms ${result.range.startMonth}→${result.range.endMonth} · ${plural(result.keywords.length, "keyword")}`;
  if (result.keywords.length === 0) {
    return `${header}\nGoogle reported no search terms for this range.`;
  }
  return [
    header,
    formatMcpTable(result.keywords, [
      { header: "keyword", value: (row) => row.keyword },
      {
        header: "impressions",
        value: (row) =>
          row.impressions ??
          (row.impressionsBelow === null ? null : `<${row.impressionsBelow}`),
      },
    ]),
  ].join("\n");
}
