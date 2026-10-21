import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataforseoClient } from "./client";
import {
  getDataforseoKey,
  getGoogleFallbackKey,
} from "@/server/lib/runtime-env";

// DATAFORSEO_SCOPE=backlinks on a self-hosted install: only the Backlinks API
// reaches DataForSEO, under a monthly request budget kept in the real usage
// table; every other feature runs as without a key, on its stand-in.

const state = await vi.hoisted(async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const client = createClient({ url: "file::memory:" });
  return { client, db: drizzle(client), fetch: vi.fn<typeof fetch>() };
});
vi.mock("@/db", () => ({ db: state.db }));
vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

const dataforseo = createDataforseoClient({
  organizationId: "org",
  userId: "user",
  userEmail: "owner@example.com",
});
const backlinksSummary = () =>
  dataforseo.backlinks.summary({ target: "example.com" });

beforeEach(async () => {
  await state.client.executeMultiple(
    `DROP TABLE IF EXISTS google_places_usage;
    ${readFileSync("drizzle/sqlite/0055_google_places_usage.sql", "utf8")}`,
  );
  vi.stubEnv("AUTH_MODE", "local_noauth");
  vi.stubEnv("DATAFORSEO_API_KEY", "dataforseo-key");
  vi.stubEnv("DATAFORSEO_SCOPE", "backlinks");
  vi.stubEnv("GOOGLE_PAGESPEED_API_KEY", "pagespeed-key");
  vi.stubGlobal("fetch", state.fetch);
  state.fetch.mockImplementation(async () =>
    Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: ["v3", "backlinks", "summary", "live"],
          cost: 0.02,
          result: [{ backlinks: 7 }],
        },
      ],
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => state.client.close());

it("sends backlinks to DataForSEO and keeps every other feature on its stand-in", async () => {
  await expect(backlinksSummary()).resolves.toMatchObject({ backlinks: 7 });
  const [url, init] = state.fetch.mock.calls[0];
  expect(url).toBe("https://api.dataforseo.com/v3/backlinks/summary/live");
  expect(new Headers(init?.headers).get("Authorization")).toBe(
    "Basic dataforseo-key",
  );

  await expect(
    dataforseo.domain.rankOverview({
      target: "example.com",
      locationCode: 2840,
      languageCode: "en",
    }),
  ).rejects.toThrow("DATAFORSEO_API_KEY");
  expect(state.fetch).toHaveBeenCalledOnce();
  expect(await getGoogleFallbackKey("GOOGLE_PAGESPEED_API_KEY")).toBe(
    "pagespeed-key",
  );
});

it("refuses backlinks requests past the monthly budget without sending them", async () => {
  vi.stubEnv("DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS", "2");

  await backlinksSummary();
  await backlinksSummary();
  await expect(backlinksSummary()).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
  expect(state.fetch).toHaveBeenCalledTimes(2);
});

it("ignores the scope on hosted, which uses DataForSEO for everything", async () => {
  vi.stubEnv("AUTH_MODE", "hosted");

  expect(await getDataforseoKey("other")).toBe("dataforseo-key");
  expect(await getGoogleFallbackKey("GOOGLE_PAGESPEED_API_KEY")).toBeNull();
});
