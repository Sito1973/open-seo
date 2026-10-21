import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Requests counted per billing month and SKU, so a self-hosted install stays
// inside the free monthly usage caps of Google Places, of Bright Data's SERP
// API ("brightdata_serp"), of SerpApi ("serpapi") and of Open PageRank
// ("open_pagerank", counted in domains), and inside its own monthly budgets of
// DataForSEO Backlinks API requests ("dataforseo_backlinks", with
// DATAFORSEO_SCOPE=backlinks) and of the Bright Data requests that keyword
// difficulty estimates may send ("difficulty_estimate", a share of
// "brightdata_serp") and of Google autocomplete lookups for keyword research
// ("google_autocomplete"). It holds no tenant data on purpose: each
// cap belongs to the install's provider account, and none runs on hosted.
export const googlePlacesUsage = sqliteTable(
  "google_places_usage",
  {
    // "YYYY-MM" in the zone the provider resets its cap in:
    // America/Los_Angeles for Google, UTC for the others.
    month: text("month").notNull(),
    sku: text("sku", {
      enum: [
        "text_search_pro",
        "text_search_enterprise",
        "place_details_enterprise_atmosphere",
        "brightdata_serp",
        "serpapi",
        "dataforseo_backlinks",
        "open_pagerank",
        "difficulty_estimate",
        "google_autocomplete",
      ],
    }).notNull(),
    calls: integer("calls").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.month, table.sku] })],
);
