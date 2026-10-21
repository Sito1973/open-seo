import { afterEach, describe, expect, it, vi } from "vitest";

const createDataforseoClientMock = vi.hoisted(() => vi.fn());

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: createDataforseoClientMock,
}));

vi.mock("@/server/lib/r2", () => ({
  putTextToR2: vi.fn(),
}));

import { fetchLighthouseResult, selectLighthouseSample } from "./lighthouse";

const okPage = (url: string) => ({
  url,
  statusCode: 200,
  fetchClass: "ok" as const,
});

describe("selectLighthouseSample", () => {
  it("does not spend checks on a bot challenge that answered 200", () => {
    const selected = selectLighthouseSample(
      [
        { ...okPage("https://example.com/"), fetchClass: "blocked" },
        okPage("https://example.com/about"),
      ],
      "https://example.com/",
      "auto",
    );

    expect(selected).toEqual(["https://example.com/about"]);
  });

  it("includes a start page reached through a trailing-slash redirect", () => {
    const pages = [
      ...Array.from({ length: 10 }, (_, index) =>
        okPage(`https://example.com/section${index}`),
      ),
      okPage("https://example.com/services/"),
    ];

    const selected = selectLighthouseSample(
      pages,
      "https://example.com/services",
      "auto",
    );

    expect(selected).toHaveLength(10);
    expect(selected[0]).toBe("https://example.com/services/");
  });

  it("prefers an exact start page when both slash forms return 2xx", () => {
    const selected = selectLighthouseSample(
      [
        okPage("https://example.com/services/"),
        okPage("https://example.com/services"),
      ],
      "https://example.com/services",
      "auto",
    );

    expect(selected[0]).toBe("https://example.com/services");
  });

  it("does not sample another page from the start page's template", () => {
    const selected = selectLighthouseSample(
      [
        okPage("https://example.com/products/123"),
        okPage("https://example.com/products/456"),
        okPage("https://example.com/about"),
      ],
      "https://example.com/products/123",
      "auto",
    );

    expect(selected).toEqual([
      "https://example.com/products/123",
      "https://example.com/about",
    ]);
  });
});

describe("fetchLighthouseResult", () => {
  const billingCustomer = {
    userId: "user-1",
    userEmail: "test@example.com",
    organizationId: "org-1",
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses PageSpeed Insights when only GOOGLE_PAGESPEED_API_KEY is set", async () => {
    vi.stubEnv("DATAFORSEO_API_KEY", "");
    vi.stubEnv("GOOGLE_PAGESPEED_API_KEY", "psi-key");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        lighthouseResult: {
          categories: {
            performance: { score: 0.54 },
            accessibility: { score: 0.93 },
            "best-practices": { score: 0.79 },
            seo: { score: 0.92 },
          },
          audits: {
            "largest-contentful-paint": { numericValue: 2500 },
            "cumulative-layout-shift": { numericValue: 0.05 },
            "server-response-time": { numericValue: 120 },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const fetched = await fetchLighthouseResult(
      "https://example.com/",
      "page-1",
      "mobile",
      billingCustomer,
    );

    expect(fetched.result).toMatchObject({
      performanceScore: 54,
      accessibilityScore: 93,
      bestPracticesScore: 79,
      seoScore: 92,
      lcpMs: 2500,
      cls: 0.05,
      ttfbMs: 120,
    });
    const request = new Request(...fetchMock.mock.calls[0]);
    const params = new URL(request.url).searchParams;
    expect(params.getAll("category")).toEqual([
      "PERFORMANCE",
      "ACCESSIBILITY",
      "BEST_PRACTICES",
      "SEO",
    ]);
    expect(params.get("strategy")).toBe("MOBILE");
    // The key travels in a header so it never lands in a logged URL.
    expect(params.has("key")).toBe(false);
    expect(request.headers.get("X-Goog-Api-Key")).toBe("psi-key");
    expect(createDataforseoClientMock).not.toHaveBeenCalled();
  });

  it("does not retry an ambiguous generic failure", async () => {
    const live = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        scores: {
          performance: 90,
          accessibility: 91,
          "best-practices": 92,
          seo: 93,
        },
        metrics: {
          largestContentfulPaint: { numericValue: 1000 },
          cumulativeLayoutShift: { numericValue: 0.01 },
          interactionToNextPaint: { numericValue: 100 },
          serverResponseTime: { numericValue: 200 },
        },
      });
    createDataforseoClientMock.mockReturnValue({
      lighthouse: { live },
    });

    const fetched = await fetchLighthouseResult(
      "https://example.com/",
      "page-1",
      "desktop",
      billingCustomer,
    );

    expect(live).toHaveBeenCalledOnce();
    expect(fetched.result.errorMessage).toBe("temporary failure");
  });
});
