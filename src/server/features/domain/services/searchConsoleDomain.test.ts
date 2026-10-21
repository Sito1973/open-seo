import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { DomainService } from "./DomainService";

const mocks = vi.hoisted(() => ({
  usesGoogleFallbacks: vi.fn(),
  listByOrganization: vi.fn(),
  getPerformance: vi.fn(),
  listKeywordMetricsForMarket: vi.fn(),
  createDataforseoClient: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: vi.fn(async () => "cache-key"),
  getCached: vi.fn(async () => null),
  setCached: vi.fn(async () => {}),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  usesGoogleFallbacks: mocks.usesGoogleFallbacks,
}));
vi.mock("@/server/features/google/oauth-config", () => ({
  hasGoogleOAuthConfig: vi.fn(async () => true),
}));
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: { listByOrganization: mocks.listByOrganization },
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: mocks.getPerformance },
  isExpectedGrantFailure: () => false,
}));
vi.mock(
  "@/server/features/keywords/repositories/KeywordResearchRepository",
  () => ({
    KeywordResearchRepository: {
      listKeywordMetricsForMarket: mocks.listKeywordMetricsForMarket,
    },
  }),
);
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

const billing: BillingCustomerContext = {
  organizationId: "org_1",
  userId: "user_1",
  userEmail: "owner@example.com",
};

function keywordsPage(overrides: Record<string, unknown> = {}) {
  return DomainService.getKeywordsPage(
    {
      projectId: "project_1",
      domain: "bandidos.co",
      scope: "domain",
      locationCode: 2170,
      languageCode: "es",
      page: 1,
      pageSize: 50,
      sortMode: "traffic",
      sortOrder: "desc",
      filters: {},
      ...overrides,
    },
    billing,
  );
}

type SearchConsoleRow = {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position?: number;
};

/** The site's `[query, page]` report, and its `[page]` report (one page each). */
function searchConsoleRows(rows: SearchConsoleRow[]) {
  mocks.getPerformance.mockImplementation(
    async ({ dimensions }: { dimensions: string[] }) => ({
      request: { startDate: "2026-09-20", endDate: "2026-10-18" },
      rows: rows.map((row) => ({
        keys: dimensions.length === 2 ? [row.query, row.page] : [row.page],
        clicks: row.clicks,
        impressions: row.impressions,
        position: row.position ?? 1,
      })),
    }),
  );
}

describe("domain research from Search Console", () => {
  beforeEach(() => {
    mocks.usesGoogleFallbacks.mockResolvedValue(true);
    mocks.listByOrganization.mockResolvedValue([
      { projectId: "project_1", siteUrl: "https://lenos.co/" },
      { projectId: "project_2", siteUrl: "sc-domain:bandidos.co" },
    ]);
    mocks.listKeywordMetricsForMarket.mockResolvedValue([
      {
        keyword: "bandidos pereira",
        searchVolume: 590,
        cpc: 0.3,
        keywordDifficulty: null,
      },
    ]);
  });

  it("serves an organization's own site, scoped to the target", async () => {
    searchConsoleRows([
      {
        query: "bandidos pereira",
        page: "https://www.bandidos.co/",
        clicks: 10,
        impressions: 100,
        position: 1,
      },
      {
        query: "bandidos pereira",
        page: "https://www.bandidos.co/menu",
        clicks: 2,
        impressions: 300,
        position: 5,
      },
      // A subdomain, outside the "domain" scope.
      {
        query: "domicilios pereira",
        page: "https://pedidos.bandidos.co/",
        clicks: 5,
        impressions: 50,
      },
    ]);

    const page = await keywordsPage();
    const overview = await DomainService.getOverview(
      {
        projectId: "project_1",
        domain: "bandidos.co",
        scope: "domain",
        locationCode: 2170,
        languageCode: "es",
      },
      billing,
    );

    // The property is connected in another project of the organization.
    expect(mocks.getPerformance).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project_2" }),
    );
    expect(page.dataSource).toBe("gsc");
    expect(page.keywords).toEqual([
      {
        keyword: "bandidos pereira",
        // Weighted by impressions: (1 × 100 + 5 × 300) / 400.
        position: 4,
        searchVolume: 590,
        traffic: 12,
        cpc: 0.3,
        url: "https://www.bandidos.co/menu",
        relativeUrl: "/menu",
        keywordDifficulty: null,
        impressions: 400,
      },
    ]);
    expect(overview).toMatchObject({
      organicTraffic: 12,
      organicKeywords: 1,
      searchConsole: { siteUrl: "sc-domain:bandidos.co" },
    });
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
  });

  it("filters and sorts in memory, rows without the value last", async () => {
    mocks.listKeywordMetricsForMarket.mockResolvedValue([
      { keyword: "menu", searchVolume: 100, cpc: null, keywordDifficulty: 10 },
      { keyword: "carta", searchVolume: 50, cpc: null, keywordDifficulty: 20 },
    ]);
    searchConsoleRows(
      ["domicilio", "menu", "carta"].map((query) => ({
        query,
        page: `https://bandidos.co/${query}`,
        clicks: 1,
        impressions: 10,
      })),
    );

    const sorted = await keywordsPage({
      sortMode: "volume",
      sortOrder: "asc",
      pageSize: 2,
    });
    const filtered = await keywordsPage({ filters: { minKd: 15 } });

    expect(sorted.keywords.map((row) => row.keyword)).toEqual([
      "carta",
      "menu",
    ]);
    expect(sorted).toMatchObject({ totalCount: 3, hasMore: true });
    expect(filtered.keywords.map((row) => row.keyword)).toEqual(["carta"]);
  });

  it("leaves installs that use DataForSEO for domain research on it", async () => {
    mocks.usesGoogleFallbacks.mockResolvedValue(false);
    const rankedKeywords = vi
      .fn()
      .mockResolvedValue({ items: [], totalCount: 0 });
    mocks.createDataforseoClient.mockReturnValue({
      domain: { rankedKeywords },
    });

    const page = await keywordsPage();

    expect(rankedKeywords).toHaveBeenCalled();
    expect(mocks.listByOrganization).not.toHaveBeenCalled();
    expect(page.dataSource).toBeUndefined();
  });
});
