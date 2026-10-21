import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingCustomerContext } from "@/server/billing/subscription";

const mocks = vi.hoisted(() => ({
  assertLocalResearchLocation: vi.fn(async () => {}),
  buildCacheKey: vi.fn(async () => "serp:analysis:key"),
  createDataforseoClient: vi.fn(),
  getBrightDataSerp: vi.fn(),
  fetchBrightDataSerp: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(async () => {}),
}));

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));

vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: mocks.buildCacheKey,
  getCached: mocks.getCached,
  setCached: mocks.setCached,
}));

vi.mock("./local-volume", () => ({
  assertLocalResearchLocation: mocks.assertLocalResearchLocation,
}));

vi.mock("@/server/lib/dataforseo", () => ({
  SERP_ANALYSIS_DEPTH: 20,
  createDataforseoClient: mocks.createDataforseoClient,
}));

vi.mock("@/server/lib/brightDataSerp", () => ({
  getBrightDataSerp: mocks.getBrightDataSerp,
  fetchBrightDataSerp: mocks.fetchBrightDataSerp,
}));

import { getSerpAnalysis } from "./serp";

const billingCustomer: BillingCustomerContext = {
  organizationId: "org_1",
  userId: "user_1",
  userEmail: "alice@example.com",
};

const input = {
  projectId: "proj_1",
  keyword: "seo tools",
  locationCode: 2840,
  languageCode: "en",
};

function cachedSnapshot(depth: number) {
  return {
    requestedKeyword: "seo tools",
    depth,
    items: [
      {
        rank: 1,
        title: "Cached",
        url: "https://cached.example",
        domain: "cached.example",
        description: "",
        etv: null,
        estimatedPaidTrafficCost: null,
        referringDomains: null,
        backlinks: null,
        isNew: false,
        rankChange: null,
      },
    ],
  };
}

beforeEach(() => {
  mocks.getBrightDataSerp.mockResolvedValue(null);
});

function mockLiveSerp() {
  const live = vi.fn().mockResolvedValue([
    {
      type: "organic",
      rank_group: 1,
      title: "Live",
      url: "https://live.example",
      domain: "live.example",
    },
  ]);
  mocks.createDataforseoClient.mockReturnValue({ serp: { live } });
  return live;
}

describe("getSerpAnalysis cache depth", () => {
  it("keeps a good snapshot when the deeper crawl comes back empty", async () => {
    mocks.getCached.mockResolvedValue(cachedSnapshot(20));
    mocks.createDataforseoClient.mockReturnValue({
      serp: { live: vi.fn().mockResolvedValue([]) },
    });

    const result = await getSerpAnalysis(
      { ...input, depth: 100 },
      billingCustomer,
    );

    expect(result.items).toEqual([]);
    // Caching the empty deep result would answer every shallower request with
    // nothing until the entry expires.
    expect(mocks.setCached).not.toHaveBeenCalled();
  });

  it("serves a depth-100 snapshot for a depth-20 request", async () => {
    mocks.getCached.mockResolvedValue(cachedSnapshot(100));
    const live = mockLiveSerp();

    const result = await getSerpAnalysis(
      { ...input, depth: 20 },
      billingCustomer,
    );

    expect(live).not.toHaveBeenCalled();
    expect(result.depth).toBe(100);
    expect(result.items[0]?.title).toBe("Cached");
  });

  it("refetches live at depth 100 when only a depth-20 snapshot is cached", async () => {
    mocks.getCached.mockResolvedValue(cachedSnapshot(20));
    const live = mockLiveSerp();

    const result = await getSerpAnalysis(
      { ...input, depth: 100 },
      billingCustomer,
    );

    expect(live).toHaveBeenCalledWith(expect.objectContaining({ depth: 100 }));
    expect(result.items[0]?.title).toBe("Live");
    // The deeper snapshot replaces the shallow entry under the same key.
    expect(mocks.setCached).toHaveBeenCalledWith(
      "serp:analysis:key",
      expect.objectContaining({ depth: 100 }),
      expect.any(Number),
    );
  });

  it("fetches and caches the SERP for the selected area", async () => {
    mocks.getCached.mockResolvedValue(null);
    const live = mockLiveSerp();
    const locationName = "Austin,Texas,United States";

    await getSerpAnalysis(
      { ...input, depth: 20, locationName },
      billingCustomer,
    );

    expect(mocks.assertLocalResearchLocation).toHaveBeenCalledWith(
      2840,
      locationName,
    );
    expect(live).toHaveBeenCalledWith(
      expect.objectContaining({ locationName }),
    );
    // A national snapshot must never answer a local request.
    expect(mocks.buildCacheKey).toHaveBeenCalledWith(
      "serp:analysis",
      expect.objectContaining({ locationName }),
    );
  });
});

describe("getSerpAnalysis on Bright Data", () => {
  it("stops at depth 50 and fetches only the pages after the cached ones", async () => {
    const config = { apiKey: "bd-key", zone: "serp" };
    mocks.getBrightDataSerp.mockResolvedValue(config);
    mocks.getCached.mockResolvedValue(cachedSnapshot(20));
    mocks.fetchBrightDataSerp.mockResolvedValue({
      organic: [
        {
          position: 2,
          title: "Deeper",
          url: "https://deeper.example/",
          domain: "deeper.example",
          description: null,
        },
      ],
    });

    const result = await getSerpAnalysis(
      { ...input, depth: 100 },
      billingCustomer,
    );

    // Google pages by offset on Bright Data: the cached snapshot's two pages
    // are not bought again.
    expect(mocks.fetchBrightDataSerp).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ depth: 50 }),
      { pages: 2, organicCount: 1 },
    );
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      depth: 50,
      maxDepth: 50,
      items: [
        { rank: 1, title: "Cached" },
        { rank: 2, domain: "deeper.example", description: "", etv: null },
      ],
    });
  });
});
