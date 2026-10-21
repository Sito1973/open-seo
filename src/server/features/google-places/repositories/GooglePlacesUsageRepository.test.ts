import { readFileSync } from "node:fs";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { GooglePlacesUsageRepository } from "./GooglePlacesUsageRepository";

// Runs the real conditional upsert against the generated migration: the
// monthly budget is only as safe as this SQL.
const state = await vi.hoisted(async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const client = createClient({ url: "file::memory:" });
  return { client, db: drizzle(client) };
});
vi.mock("@/db", () => ({ db: state.db }));
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

beforeEach(async () => {
  await state.client.executeMultiple(
    `DROP TABLE IF EXISTS google_places_usage;
    ${readFileSync("drizzle/sqlite/0055_google_places_usage.sql", "utf8")}`,
  );
});
afterAll(() => state.client.close());

const reserve = (count: number) =>
  GooglePlacesUsageRepository.reserveCalls({
    month: "2026-10",
    sku: "text_search_pro",
    count,
    limit: 10,
  });

it("reserves up to the limit and refuses a batch that would pass it", async () => {
  expect(await reserve(9)).toBe(9);
  expect(await reserve(2)).toBeNull();
  expect(await reserve(1)).toBe(10);
  expect(await reserve(1)).toBeNull();
});

it("keeps a separate counter per SKU and per month", async () => {
  expect(await reserve(10)).toBe(10);
  expect(
    await GooglePlacesUsageRepository.reserveCalls({
      month: "2026-10",
      sku: "text_search_enterprise",
      count: 1,
      limit: 10,
    }),
  ).toBe(1);
  expect(
    await GooglePlacesUsageRepository.reserveCalls({
      month: "2026-11",
      sku: "text_search_pro",
      count: 10,
      limit: 10,
    }),
  ).toBe(10);
});
