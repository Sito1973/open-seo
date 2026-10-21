import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

// Keep this definition structurally identical to ../google-places.schema.ts.
export const googlePlacesUsage = pgTable(
  "google_places_usage",
  {
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
