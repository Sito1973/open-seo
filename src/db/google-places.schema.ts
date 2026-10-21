import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Requests counted per billing month and SKU, so a self-hosted install stays
// inside the free monthly usage caps of Google Places and of Bright Data's
// SERP API ("brightdata_serp"). It holds no tenant data on purpose: each cap
// belongs to the install's provider account, and neither runs on hosted.
export const googlePlacesUsage = sqliteTable(
  "google_places_usage",
  {
    // "YYYY-MM" in the zone the provider resets its cap in:
    // America/Los_Angeles for Google, UTC for Bright Data.
    month: text("month").notNull(),
    sku: text("sku", {
      enum: [
        "text_search_pro",
        "text_search_enterprise",
        "place_details_enterprise_atmosphere",
        "brightdata_serp",
      ],
    }).notNull(),
    calls: integer("calls").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.month, table.sku] })],
);
