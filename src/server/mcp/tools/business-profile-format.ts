import type { GbpListingService } from "@/server/features/gbp/services/GbpListingService";
import type { EditResult } from "@/server/features/gbp/services/gbpListingShapes";
import type { GbpService } from "@/server/features/gbp/services/GbpService";
import {
  formatMcpCell,
  formatMcpTable,
  truncatedCell,
} from "@/server/mcp/table";

// Text renderers for the Google Business Profile tools. Full values stay in
// structuredContent; the text is what most clients hand the model.

type Locations = Awaited<ReturnType<typeof GbpService.listLocations>>;
type Reviews = Awaited<ReturnType<typeof GbpService.getReviews>>;
type Performance = Awaited<ReturnType<typeof GbpService.getPerformance>>;
type Keywords = Awaited<ReturnType<typeof GbpService.getSearchKeywords>>;
type Listing = Awaited<ReturnType<typeof GbpListingService.getListing>>;
type Categories = Awaited<
  ReturnType<typeof GbpListingService.searchCategories>
>;

const MENU_ROWS = 60;

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

type HoursRow = Listing["listing"]["regularHours"][number];

const formatHours = (hours: HoursRow[]) =>
  hours
    .map(
      (period) =>
        `${period.day} ${period.open}-${period.close}${period.closeDay ? ` (closes ${period.closeDay})` : ""}`,
    )
    .join("; ") || "none";

const formatCategory = (value: { name: string; displayName: string | null }) =>
  `${value.displayName ?? "?"} (${value.name})`;

export function formatListingText(result: Listing): string {
  const { listing, status } = result;
  const setAttributes = result.attributes.filter(
    (attribute) =>
      attribute.value !== null &&
      !(Array.isArray(attribute.value) && attribute.value.length === 0),
  );
  const lines = [
    `${listing.title} (${result.location}) · ${listing.address ?? "no address"}`,
    `Primary category: ${listing.primaryCategory ? formatCategory(listing.primaryCategory) : "none"}`,
    `Additional categories: ${listing.additionalCategories.map(formatCategory).join(", ") || "none"}`,
    `Description (${listing.description?.length ?? 0}/750 chars): ${listing.description ?? "none"}`,
    `Website: ${listing.websiteUri ?? "none"}`,
    `Phones: ${listing.primaryPhone ?? "none"}${listing.additionalPhones.length > 0 ? ` · additional ${listing.additionalPhones.join(", ")}` : ""}`,
    `Open status: ${listing.openStatus ?? "unknown"}`,
    `Regular hours: ${formatHours(listing.regularHours)}`,
    `Special hours: ${
      listing.specialHours
        .map((period) =>
          "closed" in period
            ? `${period.date} closed`
            : `${period.date} ${period.open}-${period.close}`,
        )
        .join("; ") || "none"
    }`,
    `More hours: ${
      listing.moreHours
        .map((entry) => `${entry.hoursTypeId}: ${formatHours(entry.periods)}`)
        .join(" | ") || "none"
    }`,
    `Services: ${listing.serviceItems.join(", ") || "none"}`,
    `Verified manager (hasVoiceOfMerchant): ${formatMcpCell(status.hasVoiceOfMerchant)} · edits pending Google review: ${status.pendingFields.join(", ") || "none"} · fields Google changed: ${status.googleUpdatedFields.join(", ") || "none"} · posts allowed: ${formatMcpCell(status.canOperateLocalPost)} · food menu allowed: ${formatMcpCell(status.canHaveFoodMenus)}`,
    "",
    `Attributes set (${setAttributes.length}):`,
    formatMcpTable(setAttributes, [
      { header: "name", value: (row) => row.name },
      { header: "label", value: (row) => row.displayName },
      { header: "value", value: (row) => row.value },
    ]),
    `Available attributes (${result.attributes.length}; allowed values in structuredContent): ${result.attributes
      .map((attribute) => `${attribute.name} · ${attribute.valueType ?? "?"}`)
      .join(", ")}`,
  ];
  if (result.recentPosts) {
    lines.push(
      "",
      `Recent posts (${result.recentPosts.length}):`,
      formatMcpTable(result.recentPosts, [
        { header: "created", value: (row) => row.createTime?.slice(0, 10) },
        { header: "type", value: (row) => row.topicType },
        { header: "state", value: (row) => row.state },
        { header: "summary", value: (row) => row.summary },
      ]),
    );
  }
  if (result.foodMenu) {
    const { items, currencyCode } = result.foodMenu;
    lines.push(
      "",
      `Food menu (${plural(items.length, "item")}, currency ${currencyCode ?? "none"}${items.length > MENU_ROWS ? `; first ${MENU_ROWS} shown` : ""}):`,
      formatMcpTable(items.slice(0, MENU_ROWS), [
        { header: "menu", value: (row) => row.menu },
        { header: "section", value: (row) => row.section },
        { header: "item", value: (row) => row.item },
        { header: "price", value: (row) => row.price },
        {
          header: "description",
          value: (row) => row.description,
          format: truncatedCell(120),
        },
      ]),
    );
  }
  return lines.join("\n");
}

export function formatCategoriesText(
  result: Categories,
  query: string,
): string {
  if (result.categories.length === 0) {
    return `No Google Business Profile category starts with "${query}". Google matches the start of the name: try the leading word, or a shorter prefix.`;
  }
  return [
    `Categories starting with "${query}":`,
    formatMcpTable(result.categories, [
      { header: "name", value: (row) => row.name },
      { header: "displayName", value: (row) => row.displayName },
    ]),
  ].join("\n");
}

export function formatEditText(result: EditResult): string {
  const where = `${result.title} (${result.location})`;
  if (result.mode === "unchanged") {
    return `NO CHANGE — ${where}: every value already matches, so nothing was sent to Google.`;
  }
  const lines = [
    result.mode === "preview"
      ? `PREVIEW — nothing changed. ${where}`
      : `APPLIED — ${where}`,
  ];
  if (result.review) {
    const { review } = result;
    lines.push(
      `Review: ${review.rating ?? "?"}/5 by ${review.reviewer ?? "anonymous"} on ${review.createTime.slice(0, 10)}: ${review.comment ?? "(no text)"}`,
    );
  }
  lines.push(
    formatMcpTable(result.changes, [
      { header: "field", value: (row) => row.field },
      { header: "current", value: (row) => row.before },
      { header: "proposed", value: (row) => row.after },
    ]),
  );
  if (result.note) lines.push(result.note);
  if (result.mode === "preview") {
    lines.push(
      result.validatedBy === "google"
        ? "Google validated this change."
        : "Google checks this change only when it is applied.",
      "Show this to the user; call again with apply: true only after they approve it.",
    );
    return lines.join("\n");
  }
  if (result.post) {
    lines.push(
      `Post ${result.post.name}: state ${result.post.state ?? "unknown"}${result.post.searchUrl ? ` · ${result.post.searchUrl}` : ""}. Google can still reject it (state REJECTED); delete posts in Business Profile.`,
    );
  }
  lines.push(
    "Google may review edits before they show; get_google_business_profile_listing lists pending fields.",
  );
  if (result.revert) {
    lines.push(
      `To undo, preview these arguments with the same tool: ${JSON.stringify(result.revert)}`,
    );
  }
  return lines.join("\n");
}
