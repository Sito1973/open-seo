import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SerpObservationRepository } from "@/server/features/serp/repositories/SerpObservationRepository";
import { checkRankOnBrightData } from "./brightDataSerp";

// A scheduled rank check on Bright Data reuses a recently saved first page of
// the same search, from the real SERP observation store in an in-memory
// SQLite; live pages come from a mocked Bright Data.

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());
const testDb = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return createAiVisibilityTestDb();
});

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));

const search = {
  keyword: "hamburguesas pereira",
  locationCode: 2170,
  languageCode: "es",
  device: "mobile" as const,
  organizationId: "organization",
};

const scheduledCheck = () =>
  checkRankOnBrightData(
    { apiKey: "bd-key", zone: "openseo_serp" },
    {
      ...search,
      keywordId: "keyword",
      targetDomain: "bandidos.co",
      depth: 10,
      reuseFirstPage: true,
    },
  );

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async () =>
    Response.json({
      status_code: 200,
      headers: {},
      body: JSON.stringify({ organic: [{ link: "https://bandidos.co/" }] }),
    }),
  );
  await testDb.client.execute("DELETE FROM serp_observations");
  await testDb.seedProject();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("never reuses a saved page without organic results, and reuses the live page it then saves", async () => {
  await SerpObservationRepository.record({
    ...search,
    origin: "serp_tool",
    results: [],
    features: [],
  });
  // An hour old, so the live page saved next is the latest.
  await testDb.client.execute({
    sql: "UPDATE serp_observations SET observed_at = ?",
    args: [new Date(Date.now() - 60 * 60 * 1000).toISOString()],
  });

  expect(await scheduledCheck()).toMatchObject({ position: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  expect(await scheduledCheck()).toMatchObject({ position: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
