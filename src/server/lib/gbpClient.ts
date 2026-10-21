import { z } from "zod";
import {
  accountsResponseSchema,
  dailyMetricsResponseSchema,
  gbpAccountNameSchema,
  gbpLocationNameSchema,
  locationsResponseSchema,
  type postalAddressSchema,
  reviewSchema,
  reviewsResponseSchema,
  searchKeywordsResponseSchema,
  type googleDateSchema,
} from "@/server/lib/gbpApiSchemas";
import { createGbpListingApi } from "@/server/lib/gbpListingApi";
import {
  BUSINESS_INFO_API_BASE,
  collectPages,
  createGbpRequest,
  reviewUrl,
  V4_API_BASE,
  v4LocationName,
} from "@/server/lib/gbpRequest";

// Google Business Profile client for the owner's own listings (self-hosted
// only). Reads are GETs. The edit functions from gbpListingApi are called
// only by GbpListingService and GbpContentService, and only from an MCP call
// with apply: true, except patchLocation with validateOnly in previews.

const ACCOUNTS_URL =
  "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const PERFORMANCE_API_BASE =
  "https://businessprofileperformance.googleapis.com/v1";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const MAX_ACCOUNTS = 200;
const MAX_LOCATIONS = 500;
const LOCATION_READ_MASK = [
  "name",
  "title",
  "storefrontAddress",
  "websiteUri",
  "categories.primaryCategory.displayName",
  "metadata.placeId",
  "metadata.mapsUri",
  "openInfo.status",
].join(",");

const STAR_RATINGS: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export type GbpLocation = {
  location: string;
  title: string;
  address: string | null;
  primaryCategory: string | null;
  placeId: string | null;
  mapsUri: string | null;
  websiteUri: string | null;
  status: string | null;
};

type GbpReview = {
  reviewId: string;
  rating: number | null;
  comment: string | null;
  createTime: string;
  updateTime: string | null;
  reviewer: string | null;
  reply: { comment: string; updateTime: string | null } | null;
};

function toReview(review: z.infer<typeof reviewSchema>): GbpReview {
  return {
    reviewId: review.reviewId,
    rating: STAR_RATINGS[review.starRating ?? ""] ?? null,
    comment: review.comment ?? null,
    createTime: review.createTime,
    updateTime: review.updateTime ?? null,
    reviewer: review.reviewer?.isAnonymous
      ? null
      : (review.reviewer?.displayName ?? null),
    reply: review.reviewReply
      ? {
          comment: review.reviewReply.comment,
          updateTime: review.reviewReply.updateTime ?? null,
        }
      : null,
  };
}

/** google.type.Date query params from YYYY-MM-DD, or YYYY-MM for a month. */
function googleDateParams(
  prefix: string,
  isoDate: string,
): Array<[string, string]> {
  const [year = "", month = "", day] = isoDate.split("-");
  const params: Array<[string, string]> = [
    [`${prefix}.year`, String(Number(year))],
    [`${prefix}.month`, String(Number(month))],
  ];
  if (day !== undefined) params.push([`${prefix}.day`, String(Number(day))]);
  return params;
}

const pad = (value: number) => String(value).padStart(2, "0");

function toIsoDate(date: z.infer<typeof googleDateSchema>): string {
  return `${date.year}-${pad(date.month)}-${pad(date.day ?? 1)}`;
}

function formatAddress(
  address: z.infer<typeof postalAddressSchema>,
): string | null {
  const parts = [
    ...(address.addressLines ?? []),
    address.locality,
    address.administrativeArea,
    address.postalCode,
    address.regionCode,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}

export function createGbpClient(opts: {
  userId: string;
  googleAccountId: string;
}) {
  const request = createGbpRequest(opts);
  const get = (url: URL | string) => request("GET", url);

  return {
    async getUserInfoEmail(): Promise<string | null> {
      const data = z
        .object({ email: z.string().email().optional() })
        .parse(await get(GOOGLE_USERINFO_URL));
      return data.email ?? null;
    },

    async listAccounts() {
      return collectPages(MAX_ACCOUNTS, async (pageToken) => {
        const url = new URL(ACCOUNTS_URL);
        url.searchParams.set("pageSize", "20");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const page = accountsResponseSchema.parse(await get(url));
        return {
          items: page.accounts ?? [],
          nextPageToken: page.nextPageToken,
        };
      });
    },

    async listLocations(accountName: string): Promise<GbpLocation[]> {
      const account = gbpAccountNameSchema.parse(accountName);
      return collectPages(MAX_LOCATIONS, async (pageToken) => {
        const url = new URL(`${BUSINESS_INFO_API_BASE}/${account}/locations`);
        url.searchParams.set("readMask", LOCATION_READ_MASK);
        url.searchParams.set("pageSize", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const page = locationsResponseSchema.parse(await get(url));
        return {
          items: (page.locations ?? []).map((location) => ({
            location: location.name,
            title: location.title,
            address: location.storefrontAddress
              ? formatAddress(location.storefrontAddress)
              : null,
            primaryCategory:
              location.categories?.primaryCategory?.displayName ?? null,
            placeId: location.metadata?.placeId ?? null,
            mapsUri: location.metadata?.mapsUri ?? null,
            websiteUri: location.websiteUri ?? null,
            status: location.openInfo?.status ?? null,
          })),
          nextPageToken: page.nextPageToken,
        };
      });
    },

    /** v4 reviews need the account in the path: accounts/A/locations/L. */
    async listReviews(input: {
      accountName: string;
      location: string;
      orderBy: "updateTime desc" | "rating" | "rating desc";
      max: number;
    }) {
      const parent = v4LocationName(input);
      let summary: { averageRating: number | null; totalReviewCount: number } =
        { averageRating: null, totalReviewCount: 0 };
      const reviews = await collectPages<GbpReview>(
        input.max,
        async (pageToken) => {
          const url = new URL(`${V4_API_BASE}/${parent}/reviews`);
          url.searchParams.set("pageSize", "50");
          url.searchParams.set("orderBy", input.orderBy);
          if (pageToken) url.searchParams.set("pageToken", pageToken);
          const page = reviewsResponseSchema.parse(await get(url));
          summary = {
            averageRating: page.averageRating ?? null,
            totalReviewCount: page.totalReviewCount ?? 0,
          };
          return {
            items: (page.reviews ?? []).map(toReview),
            nextPageToken: page.nextPageToken,
          };
        },
      );
      return { ...summary, reviews };
    },

    /** Daily points per metric; days Google omits are left to the caller. */
    async fetchDailyMetrics(input: {
      location: string;
      metrics: readonly string[];
      startDate: string;
      endDate: string;
    }) {
      const location = gbpLocationNameSchema.parse(input.location);
      const url = new URL(
        `${PERFORMANCE_API_BASE}/${location}:fetchMultiDailyMetricsTimeSeries`,
      );
      for (const metric of input.metrics) {
        url.searchParams.append("dailyMetrics", metric);
      }
      for (const [key, value] of [
        ...googleDateParams("dailyRange.start_date", input.startDate),
        ...googleDateParams("dailyRange.end_date", input.endDate),
      ]) {
        url.searchParams.set(key, value);
      }
      const data = dailyMetricsResponseSchema.parse(await get(url));
      return (data.multiDailyMetricTimeSeries ?? []).flatMap((group) =>
        (group.dailyMetricTimeSeries ?? []).flatMap((series) =>
          (series.timeSeries?.datedValues ?? []).map((point) => ({
            metric: series.dailyMetric,
            date: toIsoDate(point.date),
            value: Number(point.value ?? 0),
          })),
        ),
      );
    },

    /** Monthly search terms; `startMonth`/`endMonth` are YYYY-MM. */
    async listSearchKeywords(input: {
      location: string;
      startMonth: string;
      endMonth: string;
      max: number;
    }) {
      const location = gbpLocationNameSchema.parse(input.location);
      return collectPages(input.max, async (pageToken) => {
        const url = new URL(
          `${PERFORMANCE_API_BASE}/${location}/searchkeywords/impressions/monthly`,
        );
        for (const [key, value] of [
          ...googleDateParams("monthlyRange.start_month", input.startMonth),
          ...googleDateParams("monthlyRange.end_month", input.endMonth),
        ]) {
          url.searchParams.set(key, value);
        }
        url.searchParams.set("pageSize", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const page = searchKeywordsResponseSchema.parse(await get(url));
        return {
          items: (page.searchKeywordsCounts ?? []).map((row) => ({
            keyword: row.searchKeyword,
            impressions:
              row.insightsValue?.value === undefined
                ? null
                : Number(row.insightsValue.value),
            impressionsBelow:
              row.insightsValue?.threshold === undefined
                ? null
                : Number(row.insightsValue.threshold),
          })),
          nextPageToken: page.nextPageToken,
        };
      });
    },

    async getReview(input: {
      accountName: string;
      location: string;
      reviewId: string;
    }): Promise<GbpReview> {
      return toReview(reviewSchema.parse(await get(reviewUrl(input))));
    },

    // Listing reads and edits, for GbpListingService and GbpContentService.
    ...createGbpListingApi(request),
  };
}
