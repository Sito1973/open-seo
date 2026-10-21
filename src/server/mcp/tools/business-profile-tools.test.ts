/* eslint-disable max-lines -- every Business Profile tool is covered in this one spec, sharing one stubbed Google */
import { beforeEach, expect, it, vi } from "vitest";
import {
  createGoogleBusinessProfilePostTool,
  replyToGoogleBusinessProfileReviewTool,
  updateGoogleBusinessProfileFoodMenuTool,
} from "./business-profile-content-tools";
import {
  getGoogleBusinessProfileListingTool,
  updateGoogleBusinessProfileAttributesTool,
  updateGoogleBusinessProfileListingTool,
} from "./business-profile-edit-tools";
import {
  getGoogleBusinessProfilePerformanceTool,
  getGoogleBusinessProfileReviewsTool,
  listGoogleBusinessProfileLocationsTool,
} from "./business-profile-tools";
import { makeToolContext, textContent } from "./tool-test-support";

// The Business Profile tools against stubbed Google APIs: the project is bound
// to accounts/1, whose only location is locations/2 unless a test says so.

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
const location = "locations/2";
const locationsRoute = (
  locations: unknown[] = [{ name: location, title: "Burger Land" }],
) => ({
  "GET /v1/accounts/1/locations": () => Response.json({ locations }),
});
const brands = [
  {
    name: "locations/10",
    title: "Burgerland",
    websiteUri: "https://www.burgerland.co/",
  },
  {
    name: "locations/11",
    title: "Bandidos",
    websiteUri: "https://bandidos.co",
  },
  {
    name: "locations/12",
    title: "Third brand",
    websiteUri: "https://third.co",
  },
];

const urlOf = (input: RequestInfo | URL) =>
  input instanceof Request ? input.url : input.toString();

/** Answers each Google request by "METHOD url-fragment"; first match wins. */
function google(routes: Record<string, () => Response>) {
  mocks.fetch.mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${urlOf(input)}`;
    const route = Object.entries(routes).find(([key]) => {
      const [method = "", fragment = ""] = key.split(" ");
      return request.startsWith(`${method} `) && request.includes(fragment);
    });
    if (!route) throw new Error(`Unexpected request: ${request}`);
    return route[1]();
  });
}

function requestedUrls() {
  return mocks.fetch.mock.calls.map(([input]) => urlOf(input));
}

/** Every request that is not a GET, with its parsed URL and JSON body. */
function writes() {
  return mocks.fetch.mock.calls
    .filter(([, init]) => (init?.method ?? "GET") !== "GET")
    .map(([input, init]) => ({
      url: new URL(urlOf(input)),
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    }));
}

beforeEach(() => {
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getProjectForOrganization.mockResolvedValue({
    id: projectId,
    domain: null,
    languageCode: "es",
  });
  mocks.getByProjectId.mockResolvedValue({
    accountName: "accounts/1",
    connectedByUserId: "user_123",
    googleAccountId: "google-sub",
  });
});

it("zero-fills the days Google omits and sums the totals", async () => {
  google({
    ...locationsRoute(),
    "GET :fetchMultiDailyMetricsTimeSeries": () =>
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
    location,
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
    "GET /v1/accounts/1/locations": () =>
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
    ...locationsRoute(),
    "GET /reviews": () =>
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
    ...locationsRoute(brands),
    "GET /reviews": () => Response.json({ reviews: [] }),
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

it("edits only the project's own listing when its website identifies one", async () => {
  google(locationsRoute(brands));
  mocks.getProjectForOrganization.mockResolvedValue({
    id: projectId,
    domain: "burgerland.co",
  });

  await expect(
    updateGoogleBusinessProfileListingTool.handler(
      { projectId, location: "locations/11", description: "new", apply: true },
      toolContext,
    ),
  ).rejects.toThrow("locations/11 (Bandidos) is not this project's listing");
  expect(requestedUrls()).toHaveLength(1);
});

it("reads flags Google leaves out as false and skips posts the listing cannot have", async () => {
  // Google's JSON omits false booleans: this listing is unverified and can
  // have neither posts nor a menu, so neither is requested.
  google({
    ...locationsRoute(),
    "GET /v1/locations/2?": () =>
      Response.json({ name: location, metadata: { placeId: "place-1" } }),
    "GET /v1/locations/2/attributes": () => Response.json({}),
    "GET /v1/attributes?": () => Response.json({}),
  });

  const result = await getGoogleBusinessProfileListingTool.handler(
    { projectId },
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({
    ok: true,
    status: { hasVoiceOfMerchant: false, canOperateLocalPost: false },
    recentPosts: null,
    foodMenu: null,
  });
});

it("previews with Google's validateOnly and applies the same edit, returning the values to restore", async () => {
  google({
    ...locationsRoute(),
    "GET /v1/locations/2?": () =>
      Response.json({
        name: location,
        title: "Burger Land",
        profile: { description: "old" },
        categories: {
          primaryCategory: { name: "categories/gcid:restaurant" },
          additionalCategories: [{ name: "categories/gcid:bar" }],
        },
      }),
    // A valid validateOnly PATCH answers with an empty body.
    "PATCH /v1/locations/2?": () => new Response(null),
  });
  const args = {
    projectId,
    description: "new",
    primaryCategory: "categories/gcid:hamburger_restaurant",
  };

  const preview = await updateGoogleBusinessProfileListingTool.handler(
    args,
    toolContext,
  );

  expect(preview.structuredContent).toMatchObject({
    ok: true,
    mode: "preview",
  });
  expect(writes()).toHaveLength(1);
  const [check] = writes();
  expect(check?.url.searchParams.get("validateOnly")).toBe("true");
  expect(check?.url.searchParams.get("updateMask")).toBe(
    "categories,profile.description",
  );
  // Google needs both category fields; the unsent one keeps its value.
  expect(check?.body).toEqual({
    categories: {
      primaryCategory: { name: "categories/gcid:hamburger_restaurant" },
      additionalCategories: [{ name: "categories/gcid:bar" }],
    },
    profile: { description: "new" },
  });

  const applied = await updateGoogleBusinessProfileListingTool.handler(
    { ...args, apply: true },
    toolContext,
  );

  // The apply sends exactly what the preview validated.
  const sent = writes()[1];
  expect(sent?.url.searchParams.has("validateOnly")).toBe(false);
  expect(sent?.url.searchParams.get("updateMask")).toBe(
    check?.url.searchParams.get("updateMask"),
  );
  expect(sent?.body).toEqual(check?.body);
  expect(applied.structuredContent).toEqual(
    expect.objectContaining({
      mode: "applied",
      revert: {
        location,
        description: "old",
        primaryCategory: "categories/gcid:restaurant",
      },
    }),
  );
});

it("maps hours that cross midnight to Google's periods and reads them back unchanged", async () => {
  const periods = [
    {
      openDay: "FRIDAY",
      openTime: { hours: 18, minutes: 0 },
      closeDay: "SATURDAY",
      closeTime: { hours: 2, minutes: 0 },
    },
    {
      openDay: "SATURDAY",
      openTime: { hours: 12, minutes: 0 },
      closeDay: "SATURDAY",
      closeTime: { hours: 24, minutes: 0 },
    },
  ];
  let current: unknown = { name: location };
  google({
    ...locationsRoute(),
    "GET /v1/locations/2?": () => Response.json(current),
    "PATCH /v1/locations/2?": () => new Response(null),
  });
  const args = {
    projectId,
    regularHours: [
      { day: "FRIDAY" as const, open: "18:00", close: "02:00" },
      { day: "SATURDAY" as const, open: "12:00", close: "24:00" },
    ],
  };

  await updateGoogleBusinessProfileListingTool.handler(args, toolContext);

  expect(writes()[0]?.body).toEqual({ regularHours: { periods } });

  // Google omits zero minutes; the same hours compare equal and send nothing.
  current = {
    name: location,
    regularHours: {
      periods: [
        { ...periods[0], openTime: { hours: 18 }, closeTime: { hours: 2 } },
        { ...periods[1], openTime: { hours: 12 }, closeTime: { hours: 24 } },
      ],
    },
  };
  const again = await updateGoogleBusinessProfileListingTool.handler(
    args,
    toolContext,
  );

  expect(again.structuredContent).toMatchObject({ mode: "unchanged" });
  expect(writes()).toHaveLength(1);
});

it("previews attributes without writing, then writes them by type, removes null ones and keeps every link of a list", async () => {
  const ordering = ["https://rappi.com/bl", "https://didi.com/bl"];
  google({
    ...locationsRoute(),
    "GET /v1/locations/2/attributes": () =>
      Response.json({
        attributes: [
          { name: "attributes/has_takeout", values: [true] },
          {
            name: "attributes/url_order_ahead",
            uriValues: ordering.map((uri) => ({ uri })),
          },
        ],
      }),
    "GET /v1/attributes?": () =>
      Response.json({
        attributeMetadata: [
          { parent: "attributes/has_delivery", valueType: "BOOL" },
          { parent: "attributes/url_menu", valueType: "URL" },
          { parent: "attributes/has_takeout", valueType: "BOOL" },
          { parent: "attributes/url_order_ahead", valueType: "URL" },
        ],
      }),
    "PATCH /v1/locations/2/attributes": () => Response.json({}),
  });
  const args = {
    projectId,
    attributes: [
      { name: "attributes/has_delivery", value: true },
      { name: "attributes/url_menu", value: "https://burgerland.co/menu" },
      { name: "attributes/has_takeout", value: null },
      {
        name: "attributes/url_order_ahead",
        value: [ordering[0] ?? "", "https://burgerland.co/pedir"],
      },
    ],
  };

  const preview = await updateGoogleBusinessProfileAttributesTool.handler(
    args,
    toolContext,
  );

  expect(preview.structuredContent).toMatchObject({ mode: "preview" });
  expect(writes()).toEqual([]);

  const applied = await updateGoogleBusinessProfileAttributesTool.handler(
    { ...args, apply: true },
    toolContext,
  );

  const [write] = writes();
  expect(write?.url.searchParams.get("attributeMask")).toBe(
    "attributes/has_delivery,attributes/url_menu,attributes/has_takeout,attributes/url_order_ahead",
  );
  expect(write?.body).toEqual({
    name: "locations/2/attributes",
    attributes: [
      { name: "attributes/has_delivery", values: [true] },
      {
        name: "attributes/url_menu",
        uriValues: [{ uri: "https://burgerland.co/menu" }],
      },
      {
        name: "attributes/url_order_ahead",
        uriValues: [
          { uri: "https://rappi.com/bl" },
          { uri: "https://burgerland.co/pedir" },
        ],
      },
    ],
  });
  // The undo restores both links that were replaced.
  expect(applied.structuredContent).toMatchObject({
    revert: {
      attributes: [
        { name: "attributes/has_delivery", value: null },
        { name: "attributes/url_menu", value: null },
        { name: "attributes/has_takeout", value: true },
        { name: "attributes/url_order_ahead", value: ordering },
      ],
    },
  });
});

it("refuses attributes Google does not offer the location", async () => {
  google({
    ...locationsRoute(),
    "GET /v1/locations/2/attributes": () => Response.json({}),
    "GET /v1/attributes?": () =>
      Response.json({
        attributeMetadata: [
          { parent: "attributes/has_delivery", valueType: "BOOL" },
        ],
      }),
  });

  await expect(
    updateGoogleBusinessProfileAttributesTool.handler(
      {
        projectId,
        apply: true,
        attributes: [{ name: "attributes/has_wifi", value: true }],
      },
      toolContext,
    ),
  ).rejects.toThrow("attributes/has_wifi is not available for this location");
});

const menu = (items: unknown[]) => ({
  labels: [{ displayName: "Carta" }],
  sections: [{ labels: [{ displayName: "Hamburguesas" }], items }],
});

it("previews a menu edit without writing, then writes the whole menu back with untouched allergens, options and photos", async () => {
  const classic = {
    labels: [{ displayName: "Clásica", languageCode: "es" }],
    attributes: {
      price: { currencyCode: "COP", units: "25000" },
      allergen: ["DAIRY"],
      mediaKeys: ["photo-1"],
    },
    options: [
      {
        labels: [{ displayName: "Doble" }],
        attributes: { price: { currencyCode: "COP", units: "32000" } },
      },
    ],
  };
  const bbq = {
    labels: [{ displayName: "BBQ", languageCode: "es" }],
    attributes: { price: { currencyCode: "COP", units: "26000" } },
  };
  google({
    ...locationsRoute(),
    "GET /v1/locations/2?": () =>
      Response.json({ name: location, metadata: { canHaveFoodMenus: true } }),
    "GET /v4/accounts/1/locations/2/foodMenus": () =>
      Response.json({ menus: [menu([classic, bbq])] }),
    "PATCH /v4/accounts/1/locations/2/foodMenus": () => Response.json({}),
  });
  const args = {
    projectId,
    changes: [{ section: "hamburguesas", item: "bbq", price: 28000 }],
  };

  const preview = await updateGoogleBusinessProfileFoodMenuTool.handler(
    args,
    toolContext,
  );

  expect(preview.structuredContent).toMatchObject({ mode: "preview" });
  expect(writes()).toEqual([]);

  await updateGoogleBusinessProfileFoodMenuTool.handler(
    { ...args, apply: true },
    toolContext,
  );

  const [write] = writes();
  expect(write?.url.searchParams.get("updateMask")).toBe("menus");
  expect(write?.body).toEqual({
    name: "accounts/1/locations/2/foodMenus",
    menus: [
      menu([
        classic,
        {
          ...bbq,
          attributes: { price: { currencyCode: "COP", units: "28000" } },
        },
      ]),
    ],
  });
});

it("previews a review reply without posting it, then posts it", async () => {
  google({
    ...locationsRoute(),
    "GET /v4/accounts/1/locations/2/reviews/r1": () =>
      Response.json({
        reviewId: "r1",
        starRating: "TWO",
        createTime: "2026-09-01T00:00:00Z",
      }),
    "PUT /v4/accounts/1/locations/2/reviews/r1/reply": () => Response.json({}),
  });
  const args = { projectId, reviewId: "r1", reply: "Gracias por avisarnos." };

  const preview = await replyToGoogleBusinessProfileReviewTool.handler(
    args,
    toolContext,
  );

  expect(preview.structuredContent).toMatchObject({ mode: "preview" });
  expect(writes()).toEqual([]);

  await replyToGoogleBusinessProfileReviewTool.handler(
    { ...args, apply: true },
    toolContext,
  );

  expect(writes()).toEqual([
    expect.objectContaining({ body: { comment: "Gracias por avisarnos." } }),
  ]);
});

it("previews the exact post with the complete event schedule Google requires, and publishes nothing", async () => {
  google(locationsRoute());

  const preview = await createGoogleBusinessProfilePostTool.handler(
    {
      projectId,
      topicType: "OFFER",
      summary: "2x1 en hamburguesas este fin de semana",
      event: { title: "2x1", startDate: "2026-10-24", endDate: "2026-10-26" },
    },
    toolContext,
  );

  expect(preview.structuredContent).toMatchObject({
    mode: "preview",
    changes: [
      {
        after: {
          languageCode: "es",
          event: {
            schedule: {
              startDate: { year: 2026, month: 10, day: 24 },
              startTime: { hours: 0, minutes: 0 },
              endDate: { year: 2026, month: 10, day: 26 },
              endTime: { hours: 23, minutes: 59 },
            },
          },
        },
      },
    ],
  });
  expect(writes()).toEqual([]);
});

it("returns Google's validation reason so the agent can fix the input", async () => {
  google({
    ...locationsRoute(),
    "GET /v1/locations/2?": () => Response.json({ name: location }),
    "PATCH /v1/locations/2?": () =>
      Response.json(
        {
          error: {
            code: 400,
            message: "Request contains an invalid argument.",
            details: [
              {
                reason: "STRING_TOO_LONG",
                metadata: {
                  field_mask: "profile.description",
                  max_length: "750",
                },
              },
            ],
          },
        },
        { status: 400 },
      ),
  });

  const result = await updateGoogleBusinessProfileListingTool.handler(
    { projectId, description: "new" },
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({
    ok: false,
    reason: "invalid_request",
  });
  expect(textContent(result)).toContain(
    "STRING_TOO_LONG on profile.description (max 750)",
  );
});
