import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getBusinessProfileTool,
  getBusinessReviewsTool,
  getBusinessUpdatesTool,
} from "./local-seo-tools";
import { makeToolContext, textContent } from "./tool-test-support";

// get_business_profile, get_business_reviews and get_business_updates on a
// self-hosted install without DataForSEO, against stubbed Google APIs. The
// project is bound to Business Profile account accounts/1, whose location
// locations/2 is place p-own (cid 42); p-other is someone else's.

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getByProjectId: vi.fn(),
  reserveCalls: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/google/googleOAuth", () => ({
  getGoogleAccessToken: async () => "access-token",
}));
vi.mock("@/server/features/gbp/repositories/GbpConnectionRepository", () => ({
  GbpConnectionRepository: { getByProjectId: mocks.getByProjectId },
}));
vi.mock(
  "@/server/features/google-places/repositories/GooglePlacesUsageRepository",
  () => ({
    GooglePlacesUsageRepository: { reserveCalls: mocks.reserveCalls },
  }),
);

const toolContext = makeToolContext();
const projectId = "project_1";
const review = (reviewId: string, starRating: string) => ({
  reviewId,
  starRating,
  createTime: "2026-10-01T12:00:00Z",
});

/** Answers each request whose URL contains a route's fragment; first wins. */
function google(routes: Record<string, unknown>) {
  mocks.fetch.mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    const route = Object.keys(routes).find((fragment) =>
      url.includes(fragment),
    );
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return Response.json(routes[route]);
  });
}

const ownLocations = {
  "/v1/accounts/1/locations": {
    locations: [
      {
        name: "locations/2",
        title: "Burger Land",
        metadata: {
          placeId: "p-own",
          mapsUri: "https://maps.google.com/maps?cid=42",
        },
      },
    ],
  },
};

const requestedUrls = () =>
  mocks.fetch.mock.calls.map(([input]) =>
    input instanceof Request ? input.url : input.toString(),
  );

beforeEach(() => {
  vi.stubEnv("DATAFORSEO_API_KEY", "");
  vi.stubEnv("AUTH_MODE", "");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "places-key");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getProjectForOrganization.mockResolvedValue({
    id: projectId,
    locationCode: 2170,
    languageCode: "es",
  });
  mocks.getByProjectId.mockResolvedValue({
    accountName: "accounts/1",
    connectedByUserId: "user_123",
    googleAccountId: "google-sub",
  });
  mocks.reserveCalls.mockImplementation(
    async ({ count }: { count: number }) => count,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("reads the project's own listing through Business Profile, counting stars over every review", async () => {
  google({
    ...ownLocations,
    "/v1/locations/2": {
      name: "locations/2",
      title: "Burger Land",
      categories: {
        primaryCategory: {
          name: "categories/gcid:hamburger_restaurant",
          displayName: "Hamburguesería",
        },
      },
      metadata: { hasVoiceOfMerchant: true },
    },
    "/media/customers": { totalMediaItemCount: 30 },
    "/media": { totalMediaItemCount: 12 },
    "pageToken=p2": { reviews: [review("r3", "ONE")] },
    "/reviews": {
      reviews: [review("r1", "FIVE"), review("r2", "FOUR")],
      averageRating: 3.3,
      totalReviewCount: 3,
      nextPageToken: "p2",
    },
  });

  const result = await getBusinessProfileTool.handler(
    { projectId, placeId: "p-own" },
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({
    provider: "google_business_profile",
    profile: {
      category: "Hamburguesería",
      rating: { value: 3.3, votes_count: 3 },
      rating_distribution: { 5: 1, 4: 1, 3: 0, 2: 0, 1: 1 },
      is_claimed: true,
      total_photos: 42,
      cid: "42",
    },
  });
  expect(textContent(result)).toContain("5★ 1, 4★ 1, 3★ 0, 2★ 0, 1★ 1");
  expect(mocks.reserveCalls).not.toHaveBeenCalled();
});

it("reads another business from Place Details, with null for what Places lacks", async () => {
  mocks.getByProjectId.mockResolvedValue(null);
  google({
    "places.googleapis.com/v1/places/p-other": {
      id: "p-other",
      displayName: { text: "Otra Hamburguesería" },
      rating: 4.2,
      userRatingCount: 80,
    },
  });

  const result = await getBusinessProfileTool.handler(
    { projectId, placeId: "p-other" },
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({
    provider: "google_places",
    profile: {
      title: "Otra Hamburguesería",
      rating: { value: 4.2, votes_count: 80 },
      rating_distribution: null,
      is_claimed: null,
      total_photos: null,
    },
  });
  expect(mocks.reserveCalls).toHaveBeenCalledWith(
    expect.objectContaining({ sku: "place_details_enterprise_atmosphere" }),
  );
  expect(textContent(result)).toContain(
    "Business Profile is not connected to this project",
  );
});

it("reads the own listing's reviews by cid in the requested order, with owner replies", async () => {
  google({
    ...ownLocations,
    "/reviews": {
      reviews: [
        {
          ...review("r1", "ONE"),
          comment: "Llegó frío",
          reviewReply: { comment: "Lo sentimos" },
        },
      ],
      averageRating: 4.1,
      totalReviewCount: 120,
    },
  });

  const result = await getBusinessReviewsTool.handler(
    { projectId, cid: "42", sortBy: "lowest_rating" },
    toolContext,
  );

  const reviewsUrl = new URL(
    requestedUrls().find((url) => url.includes("/reviews")) ?? "",
  );
  expect(reviewsUrl.searchParams.get("orderBy")).toBe("rating");
  expect(result.structuredContent).toMatchObject({
    status: "completed",
    provider: "google_business_profile",
    totals: { reviews_count: 120, place_id: "p-own" },
    reviews: [
      {
        rating: { value: 1 },
        review_text: "Llegó frío",
        owner_answer: "Lo sentimos",
      },
    ],
  });
});

// Google requires each review shown to credit its author and Google Maps, and
// Places says nothing about owner replies.
it("credits each Places review's author and leaves out the owner-replied column", async () => {
  google({
    ...ownLocations,
    "places.googleapis.com/v1/places/p-other": {
      id: "p-other",
      reviews: [
        {
          rating: 5,
          originalText: { text: "Excelente" },
          authorAttribution: {
            displayName: "Ana",
            uri: "https://www.google.com/maps/contrib/1",
            photoUri: "https://lh3.googleusercontent.com/a/1",
          },
          googleMapsUri: "https://www.google.com/maps/reviews/1",
        },
      ],
    },
  });

  const result = await getBusinessReviewsTool.handler(
    { projectId, placeId: "p-other" },
    toolContext,
  );

  const text = textContent(result);
  expect(text).toContain(
    "1. Ana (https://www.google.com/maps/contrib/1, avatar https://lh3.googleusercontent.com/a/1), review on Google Maps: https://www.google.com/maps/reviews/1",
  );
  expect(text).not.toContain("owner replied");
});

it("reads posts of the project's own listings only", async () => {
  google({
    ...ownLocations,
    "/localPosts": {
      localPosts: [
        {
          name: "accounts/1/locations/2/localPosts/9",
          summary: "Martes de alitas",
          createTime: "2026-10-14T15:00:00Z",
        },
      ],
    },
  });

  const own = await getBusinessUpdatesTool.handler(
    { projectId, placeId: "p-own" },
    toolContext,
  );
  expect(own.structuredContent).toMatchObject({
    updates: [{ post_text: "Martes de alitas" }],
  });

  await expect(
    getBusinessUpdatesTool.handler(
      { projectId, placeId: "p-other" },
      toolContext,
    ),
  ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(requestedUrls().some((url) => url.includes("places.googleapis"))).toBe(
    false,
  );
});
