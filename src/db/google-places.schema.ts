import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Google Places requests counted per Pacific-time billing month and SKU, so a
// self-hosted install stays inside Google's free monthly usage caps. It holds
// no tenant data on purpose: the cap belongs to the install's Google billing
// account, and Places never runs on hosted.
export const googlePlacesUsage = sqliteTable(
  "google_places_usage",
  {
    // "YYYY-MM" in America/Los_Angeles, the zone Google resets the caps in.
    month: text("month").notNull(),
    sku: text("sku", {
      enum: ["text_search_pro", "text_search_enterprise"],
    }).notNull(),
    calls: integer("calls").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.month, table.sku] })],
);
