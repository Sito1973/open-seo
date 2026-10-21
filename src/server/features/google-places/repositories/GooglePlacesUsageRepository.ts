import { sql } from "drizzle-orm";
import { db } from "@/db";
import { googlePlacesUsage } from "@/db/schema";

type GooglePlacesSku = (typeof googlePlacesUsage.$inferInsert)["sku"];

/**
 * Adds `count` calls to the month's counter for one SKU, unless that would take
 * it past `limit`. One conditional upsert, so concurrent requests can never
 * reserve more than the limit between them. Returns the new monthly total, or
 * null when the reservation was refused.
 */
async function reserveCalls(input: {
  month: string;
  sku: GooglePlacesSku;
  count: number;
  limit: number;
}): Promise<number | null> {
  const { month, sku, count, limit } = input;
  if (count > limit) return null;
  const [row] = await db
    .insert(googlePlacesUsage)
    .values({ month, sku, calls: count })
    .onConflictDoUpdate({
      target: [googlePlacesUsage.month, googlePlacesUsage.sku],
      set: { calls: sql`${googlePlacesUsage.calls} + ${count}` },
      setWhere: sql`${googlePlacesUsage.calls} + ${count} <= ${limit}`,
    })
    .returning({ calls: googlePlacesUsage.calls });
  return row?.calls ?? null;
}

export const GooglePlacesUsageRepository = { reserveCalls };
