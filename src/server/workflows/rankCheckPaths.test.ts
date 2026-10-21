import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { runLiveCheck } from "./rankCheckPaths";

// Rank checks on Bright Data's live Google SERP: a self-hosted install with
// BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE and no DataForSEO key.

const mocks = vi.hoisted(() => ({
  insertSnapshots: vi.fn(),
  updateRun: vi.fn(),
  setRunErrorIfEmpty: vi.fn(),
  reserveCalls: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: mocks }),
);
vi.mock(
  "@/server/features/google-places/repositories/GooglePlacesUsageRepository",
  () => ({
    GooglePlacesUsageRepository: { reserveCalls: mocks.reserveCalls },
  }),
);
vi.mock("@/server/lib/dataforseo", () => ({
  fetchRankCheckTaskResult: vi.fn(),
  MAX_TASKS_PER_POST: 100,
}));
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: (
    _step: unknown,
    _name: string,
    _config: unknown,
    fn: () => unknown,
  ) => fn(),
}));

type Context = Parameters<typeof runLiveCheck>[1];

const context: Context = {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the DataForSEO client is never reached on Bright Data
  client: {} as Context["client"],
  brightData: { apiKey: "bd-key", zone: "openseo_serp" },
  keywords: [{ id: "kw_1", keyword: "hamburguesas pereira" }],
  devices: "desktop",
  serpDepth: 10,
  domain: "example.com",
  locationCode: 2170,
  languageCode: "es",
  runId: "run_1",
};

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- steps run directly through the pgStep mock
const step = {} as WorkflowStep;

/** One parsed Google page in Bright Data's JSON envelope. */
function page(links: string[], extra: Record<string, unknown> = {}) {
  return Response.json({
    status_code: 200,
    headers: {},
    body: JSON.stringify({
      organic: links.map((link) => ({ link })),
      ...extra,
    }),
  });
}

function sentRequests() {
  return mocks.fetch.mock.calls.map(([url, init]) => {
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : null;
    return {
      url,
      authorization: new Headers(init?.headers).get("Authorization"),
      body,
    };
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", mocks.fetch);
  // A fresh month: every reservation fits.
  mocks.reserveCalls.mockResolvedValue(1);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("stores the domain's organic position from the country's Google page", async () => {
  mocks.fetch.mockImplementation(async () =>
    page(["https://other.co/", "https://www.example.com/menu"], {
      snack_pack: [{ name: "Burger Place" }],
    }),
  );

  await runLiveCheck(step, { ...context, devices: "both" });

  const googleUrl =
    "https://www.google.com.co/search?q=hamburguesas+pereira&hl=es&gl=co&pws=0";
  const [desktop, mobile, ...rest] = sentRequests();
  expect(desktop).toEqual({
    url: "https://api.brightdata.com/request",
    authorization: "Bearer bd-key",
    body: {
      zone: "openseo_serp",
      url: googleUrl,
      format: "json",
      data_format: "parsed",
      country: "co",
    },
  });
  expect(mobile.body).toMatchObject({ url: `${googleUrl}&brd_mobile=1` });
  expect(rest).toEqual([]);
  expect(mocks.reserveCalls).toHaveBeenCalledWith(
    expect.objectContaining({ sku: "brightdata_serp", count: 1, limit: 4500 }),
  );
  const snapshot = {
    trackingKeywordId: "kw_1",
    position: 2,
    url: "https://www.example.com/menu",
    serpFeatures: JSON.stringify(["organic", "local_pack"]),
  };
  expect(mocks.insertSnapshots).toHaveBeenCalledWith([
    expect.objectContaining({ ...snapshot, device: "desktop" }),
    expect.objectContaining({ ...snapshot, device: "mobile" }),
  ]);
});

it("pages deeper only until the domain appears, counting organic results across pages", async () => {
  mocks.fetch.mockImplementation(async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    return body.includes("start=10")
      ? page(["https://example.com/"])
      : page(Array.from({ length: 8 }, (_, i) => `https://site${i}.co/`));
  });

  await runLiveCheck(step, { ...context, serpDepth: 30 });

  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(mocks.insertSnapshots).toHaveBeenCalledWith([
    expect.objectContaining({ position: 9, url: "https://example.com/" }),
  ]);
});

it("records a page Bright Data could not fetch as a failed check", async () => {
  mocks.fetch.mockImplementation(async () =>
    Response.json({
      status_code: 502,
      headers: { "x-brd-error": "No ready cookies" },
      body: "",
    }),
  );

  await runLiveCheck(step, context);

  expect(mocks.insertSnapshots).not.toHaveBeenCalled();
  expect(mocks.setRunErrorIfEmpty).toHaveBeenCalledWith(
    "run_1",
    expect.stringContaining("No ready cookies"),
  );
});

it("sends nothing once the monthly budget is used up", async () => {
  mocks.reserveCalls.mockResolvedValue(null);

  await runLiveCheck(step, context);

  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.insertSnapshots).not.toHaveBeenCalled();
  expect(mocks.setRunErrorIfEmpty).toHaveBeenCalledWith(
    "run_1",
    expect.stringContaining("monthly Bright Data budget"),
  );
});
