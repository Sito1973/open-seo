import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getLocalSerpResultsTool,
  searchLocalBusinessesTool,
} from "./dataforseo-research-tools";
import { getLocalRankGridTool } from "./local-seo-tools";
import { makeToolContext } from "./tool-test-support";

// The Google Places path of the three switched local tools: a self-hosted
// install with GOOGLE_PLACES_API_KEY and no DataForSEO key.

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  getProjectForOrganization: vi.fn(),
  reserveCalls: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/google-places/repositories/GooglePlacesUsageRepository",
  () => ({
    GooglePlacesUsageRepository: { reserveCalls: mocks.reserveCalls },
  }),
);

const toolContext = makeToolContext();
const near = { latitude: 4.6, longitude: -74.08 };
const gridArgs = {
  projectId: "project_1",
  keyword: "cafe",
  target: { name: "acme cafe" },
  center: near,
  spacingKm: 1,
};
const serpArgs = { projectId: "project_1", keyword: "cafe", near };

beforeEach(() => {
  vi.stubEnv("DATAFORSEO_API_KEY", "");
  vi.stubEnv("AUTH_MODE", "");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "places-key");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockImplementation(async () => Response.json({}));
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    locationCode: 2170,
    languageCode: "es",
  });
  // A fresh month: every reservation fits, and the new total is the count.
  mocks.reserveCalls.mockImplementation(
    async ({ count }: { count: number }) => count,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function placesAnswer(places: unknown[]) {
  mocks.fetch.mockImplementation(async () => Response.json({ places }));
}

function sentRequests() {
  return mocks.fetch.mock.calls.map(([url, init]) => {
    const headers = new Headers(init?.headers);
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : null;
    return {
      url,
      apiKey: headers.get("X-Goog-Api-Key"),
      fieldMask: headers.get("X-Goog-FieldMask"),
      body,
    };
  });
}

it("runs the rank grid as one Text Search Pro search per point under one reservation", async () => {
  placesAnswer([
    { id: "p-other", displayName: { text: "Other Cafe" } },
    {
      id: "p-acme",
      displayName: { text: "Acme Cafe Centro" },
      googleMapsUri: "https://maps.google.com/?cid=123",
    },
  ]);

  const result = await getLocalRankGridTool.handler(gridArgs, toolContext);

  expect(mocks.reserveCalls).toHaveBeenCalledTimes(1);
  expect(mocks.reserveCalls).toHaveBeenCalledWith(
    expect.objectContaining({ sku: "text_search_pro", count: 9, limit: 4500 }),
  );
  const requests = sentRequests();
  expect(requests).toHaveLength(9);
  for (const request of requests) {
    expect(request).toMatchObject({
      url: "https://places.googleapis.com/v1/places:searchText",
      apiKey: "places-key",
      // The mask sets the price: any other field bills a pricier SKU.
      fieldMask:
        "places.id,places.displayName,places.googleMapsUri,places.attributions",
      body: {
        textQuery: "cafe",
        languageCode: "es",
        regionCode: "CO",
        pageSize: 20,
        locationBias: { circle: { radius: 1000 } },
      },
    });
  }
  expect(result.structuredContent).toMatchObject({
    status: "completed",
    provider: "google_places",
    summary: { pointsSearched: 9, pointsFound: 9, averageRank: 2 },
    matchedBusiness: {
      title: "Acme Cafe Centro",
      cid: "123",
      placeId: "p-acme",
    },
    budget: { sku: "text_search_pro", usedThisMonth: 9, limit: 4500 },
  });
  expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
});

it.each([
  [
    "get_local_rank_grid",
    () => getLocalRankGridTool.handler(gridArgs, toolContext),
  ],
  [
    "get_local_serp_results",
    () => getLocalSerpResultsTool.handler(serpArgs, toolContext),
  ],
])(
  "%s sends nothing once the monthly budget is used up",
  async (_tool, call) => {
    mocks.reserveCalls.mockResolvedValue(null);

    await expect(call()).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  },
);

it("fetches a Maps SERP with the listing mask and maps rows onto the DataForSEO shape", async () => {
  placesAnswer([
    {
      id: "p-acme",
      displayName: { text: "Acme Cafe" },
      googleMapsUri: "https://maps.google.com/?cid=123",
      rating: 4.6,
      userRatingCount: 210,
      // proto3 JSON omits zero values, here the minutes.
      regularOpeningHours: {
        periods: [{ open: { day: 0, hour: 9 }, close: { day: 0, hour: 17 } }],
      },
    },
  ]);

  const result = await getLocalSerpResultsTool.handler(serpArgs, toolContext);

  const requests = sentRequests();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.fieldMask).toBe(
    "places.id,places.displayName,places.formattedAddress,places.location,places.primaryTypeDisplayName,places.googleMapsUri,places.businessStatus,places.rating,places.userRatingCount,places.websiteUri,places.nationalPhoneNumber,places.priceLevel,places.regularOpeningHours,places.attributions,nextPageToken",
  );
  expect(result.structuredContent.results).toHaveLength(1);
  expect(result.structuredContent.results[0]).toMatchObject({
    rank_absolute: 1,
    title: "Acme Cafe",
    rating: { value: 4.6, votes_count: 210 },
    cid: "123",
    place_id: "p-acme",
    work_hours: {
      timetable: {
        sunday: [
          { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } },
        ],
      },
    },
  });
});

it("searches businesses inside the area, filtering and sorting before the offset", async () => {
  placesAnswer([
    { id: "a", rating: 4.4, userRatingCount: 50 },
    { id: "b", rating: 4, userRatingCount: 900 },
    { id: "c", rating: 4.8, userRatingCount: 300 },
    { id: "d", rating: 4.2, userRatingCount: 10 },
  ]);

  const result = await searchLocalBusinessesTool.handler(
    {
      projectId: "project_1",
      query: "cafe",
      near: { ...near, radiusKm: 2 },
      minRating: 4.2,
      sortBy: "reviews",
      offset: 1,
      limit: 2,
    },
    toolContext,
  );

  // Google rounds minRating up to the next 0.5, so 4.2 goes out as 4 and the
  // exact threshold drops "b" here.
  const body = sentRequests()[0]?.body;
  expect(body).toHaveProperty("minRating", 4);
  const corner = "locationRestriction.rectangle";
  expect(body).toHaveProperty(`${corner}.low.latitude`, expect.closeTo(4.5819));
  expect(body).toHaveProperty(
    `${corner}.low.longitude`,
    expect.closeTo(-74.098),
  );
  expect(body).toHaveProperty(
    `${corner}.high.latitude`,
    expect.closeTo(4.6181),
  );
  expect(body).toHaveProperty(
    `${corner}.high.longitude`,
    expect.closeTo(-74.062),
  );
  expect(result.structuredContent.businesses).toEqual([
    expect.objectContaining({ place_id: "a" }),
    expect.objectContaining({ place_id: "d" }),
  ]);
});

it("refuses the isClaimed filter before sending a request", async () => {
  const call = searchLocalBusinessesTool.handler(
    {
      projectId: "project_1",
      query: "cafe",
      near: { ...near, radiusKm: 2 },
      isClaimed: false,
    },
    toolContext,
  );

  await expect(call).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(call).rejects.toThrow("claimed");
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it.each([
  ["DATAFORSEO_API_KEY is set", "DATAFORSEO_API_KEY", "dataforseo-key"],
  ["the server is hosted", "AUTH_MODE", "hosted"],
])("keeps DataForSEO when %s", async (_case, name, value) => {
  vi.stubEnv(name, value);
  const businessListings = vi.fn().mockResolvedValue([]);
  mocks.createDataforseoClient.mockReturnValue({
    business: { businessListings },
  });

  await searchLocalBusinessesTool.handler(
    { projectId: "project_1", query: "cafe", near: { ...near, radiusKm: 2 } },
    toolContext,
  );

  expect(businessListings).toHaveBeenCalledTimes(1);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
