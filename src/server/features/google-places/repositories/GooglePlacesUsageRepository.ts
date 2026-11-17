import { and, eq, sql } from "drizzle-orm";
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

/** The month's counter for one SKU, without reserving anything. */
async function usedCalls(input: {
  month: string;
  sku: GooglePlacesSku;
}): Promise<number> {
  const [row] = await db
    .select({ calls: googlePlacesUsage.calls })
    .from(googlePlacesUsage)
    .where(
      and(
        eq(googlePlacesUsage.month, input.month),
        eq(googlePlacesUsage.sku, input.sku),
      ),
    );
  return row?.calls ?? 0;
}

/**
 * Corrects a reservation once its real size is known: adds `delta` to the
 * month's counter with no limit check, negative to give back what was reserved
 * and not used. The counter never goes below zero. Returns the new monthly
 * total, or null when the month has no counter to correct.
 */
async function adjustCalls(input: {
  month: string;
  sku: GooglePlacesSku;
  delta: number;
}): Promise<number | null> {
  const { month, sku, delta } = input;
  const [row] = await db
    .update(googlePlacesUsage)
    .set({
      // CASE, not max()/GREATEST(), so SQLite and Postgres run the same SQL.
      calls: sql`CASE WHEN ${googlePlacesUsage.calls} + ${delta} < 0 THEN 0 ELSE ${googlePlacesUsage.calls} + ${delta} END`,
    })
    .where(
      and(eq(googlePlacesUsage.month, month), eq(googlePlacesUsage.sku, sku)),
    )
    .returning({ calls: googlePlacesUsage.calls });
  return row?.calls ?? null;
}

export const GooglePlacesUsageRepository = {
  reserveCalls,
  usedCalls,
  adjustCalls,
};
