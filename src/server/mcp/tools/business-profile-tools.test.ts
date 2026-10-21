import { beforeEach, expect, it, vi } from "vitest";
import {
  getGoogleBusinessProfilePerformanceTool,
  getGoogleBusinessProfileReviewsTool,
  listGoogleBusinessProfileLocationsTool,
} from "./business-profile-tools";
import { makeToolContext } from "./tool-test-support";

// The Business Profile tools against stubbed Google APIs: the project is bound
// to accounts/1 and its locations come from the Business Information API.

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getByProjectId: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/google/oauth-config", () => ({
  hasGoogleOAuthConfig: async () => true,
}));
vi.mock("@/server/features/google/googleOAuth", () => ({
  getGoogleAccessToken: async () => "access-token",
}));
vi.mock("@/server/features/gbp/repositories/GbpConnectionRepository", () => ({
  GbpConnectionRepository: { getByProjectId: mocks.getByProjectId },
}));

const toolContext = makeToolContext();
const projectId = "project_1";
const location = (id: number, title: string, websiteUri: string) => ({
  name: `locations/${id}`,
  title,
  websiteUri,
});

const urlOf = (input: RequestInfo | URL) =>
  input instanceof Request ? input.url : input.toString();

/** Answers each Google request by the first URL fragment it contains. */
function google(routes: Record<string, () => Response>) {
  mocks.fetch.mockImplementation(async (input) => {
    const url = urlOf(input);
    const route = Object.entries(routes).find(([fragment]) =>
      url.includes(fragment),
    );
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return route[1]();
  });
}

function requestedUrls() {
  return mocks.fetch.mock.calls.map(([input]) => urlOf(input));
}

beforeEach(() => {
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getProjectForOrganization.mockResolvedValue({
    id: projectId,
    domain: null,
  });
  mocks.getByProjectId.mockResolvedValue({
    accountName: "accounts/1",
    accountDisplayName: "Owner",
    connectedByUserId: "user_123",
    googleAccountId: "google-sub",
  });
});

it("zero-fills the days Google omits and sums the totals", async () => {
  google({
    "/v1/accounts/1/locations": () =>
      Response.json({
        locations: [location(2, "Burgerland", "https://burgerland.co")],
      }),
    ":fetchMultiDailyMetricsTimeSeries": () =>
      Response.json({
        multiDailyMetricTimeSeries: [
          {
            dailyMetricTimeSeries: [
              {
                dailyMetric: "CALL_CLICKS",
                timeSeries: {
                  datedValues: [
                    { date: { year: 2026, month: 9, day: 1 }, value: "2" },
                    // Google leaves `value` out on a zero day.
                    { date: { year: 2026, month: 9, day: 2 } },
                  ],
                },
              },
              {
                dailyMetric: "WEBSITE_CLICKS",
                timeSeries: {
                  datedValues: [
                    { date: { year: 2026, month: 9, day: 3 }, value: "5" },
                  ],
                },
              },
            ],
          },
        ],
      }),
  });

  const result = await getGoogleBusinessProfilePerformanceTool.handler(
    { projectId, startDate: "2026-09-01", endDate: "2026-09-03" },
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({
    ok: true,
    location: "locations/2",
    totals: { callClicks: 2, websiteClicks: 5, directionRequests: 0 },
    daily: [
      { date: "2026-09-01", callClicks: 2, websiteClicks: 0 },
      { date: "2026-09-02", callClicks: 0, websiteClicks: 0 },
      { date: "2026-09-03", callClicks: 0, websiteClicks: 5 },
    ],
  });
});

it("reports a quota of 0 as API access still pending", async () => {
  google({
    "/v1/accounts/1/locations": () =>
      Response.json(
        {
          error: {
            code: 429,
            details: [
              {
                reason: "RATE_LIMIT_EXCEEDED",
                metadata: {
                  quota_limit_value: "0",
                  service: "mybusinessbusinessinformation.googleapis.com",
                },
              },
            ],
          },
        },
        { status: 429 },
      ),
  });

  const result = await listGoogleBusinessProfileLocationsTool.handler(
    { projectId },
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({
    ok: false,
    reason: "api_access_pending",
  });
});

it("maps star ratings to numbers and counts reviews without a reply", async () => {
  google({
    "/v1/accounts/1/locations": () =>
      Response.json({
        locations: [location(2, "Burgerland", "https://burgerland.co")],
      }),
    "/reviews": () =>
      Response.json({
        averageRating: 3.5,
        totalReviewCount: 2,
        reviews: [
          {
            reviewId: "r1",
            starRating: "FIVE",
            createTime: "2026-09-01T00:00:00Z",
            reviewReply: { comment: "Thanks!" },
          },
          {
            reviewId: "r2",
            starRating: "TWO",
            createTime: "2026-08-01T00:00:00Z",
          },
        ],
      }),
  });

  const result = await getGoogleBusinessProfileReviewsTool.handler(
    { projectId },
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({
    ok: true,
    unansweredCount: 1,
    reviews: [
      { reviewId: "r1", rating: 5, reply: { comment: "Thanks!" } },
      { reviewId: "r2", rating: 2, reply: null },
    ],
  });
  // v4 reviews live under the bound account.
  expect(requestedUrls().at(-1)).toContain(
    "/v4/accounts/1/locations/2/reviews",
  );
});

it("picks the location whose website is the project's domain, else asks for one", async () => {
  google({
    "/v1/accounts/1/locations": () =>
      Response.json({
        locations: [
          location(10, "Burgerland", "https://www.burgerland.co/"),
          location(11, "Bandidos", "https://bandidos.co"),
          location(12, "Third brand", "https://third.co"),
        ],
      }),
    "/reviews": () => Response.json({ reviews: [] }),
  });
  mocks.getProjectForOrganization.mockResolvedValue({
    id: projectId,
    domain: "burgerland.co",
  });

  await getGoogleBusinessProfileReviewsTool.handler({ projectId }, toolContext);

  expect(requestedUrls().at(-1)).toContain("/accounts/1/locations/10/reviews");

  mocks.getProjectForOrganization.mockResolvedValue({
    id: projectId,
    domain: "elsewhere.co",
  });
  await expect(
    getGoogleBusinessProfileReviewsTool.handler({ projectId }, toolContext),
  ).rejects.toThrow("locations/11 — Bandidos");
});
