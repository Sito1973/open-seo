import { z } from "zod";
import { getGoogleAccessToken } from "@/server/features/google/googleOAuth";
import {
  GbpApiError,
  GbpTokenError,
  type GbpErrorReason,
} from "@/server/lib/gbpErrors";
import { GBP_OAUTH_PROVIDER_ID } from "@/shared/gbp";
import {
  accountsResponseSchema,
  dailyMetricsResponseSchema,
  gbpAccountNameSchema,
  gbpLocationNameSchema,
  googleErrorSchema,
  locationsResponseSchema,
  type postalAddressSchema,
  reviewsResponseSchema,
  searchKeywordsResponseSchema,
  type googleDateSchema,
} from "@/server/lib/gbpApiSchemas";

// Read-only Google Business Profile client for the owner's own listings
// (self-hosted only). Every call is a GET; the business.manage scope it rides
// on is write-capable, so keep it that way.

const ACCOUNTS_URL =
  "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const BUSINESS_INFO_API_BASE =
  "https://mybusinessbusinessinformation.googleapis.com/v1";
const REVIEWS_API_BASE = "https://mybusiness.googleapis.com/v4";
const PERFORMANCE_API_BASE =
  "https://businessprofileperformance.googleapis.com/v1";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const MAX_ERROR_BODY_LENGTH = 8_000;
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

function classifyError(
  status: number,
  details: Array<{ reason?: string; metadata?: Record<string, string> }>,
): { reason: GbpErrorReason; service?: string } {
  // Before Google approves a Cloud project for the Business Profile APIs,
  // every API has a quota of 0 requests and answers 429; an API that is not
  // enabled answers SERVICE_DISABLED.
  const pending = details.find(
    (detail) =>
      detail.reason === "SERVICE_DISABLED" ||
      detail.metadata?.quota_limit_value === "0",
  );
  if (pending) {
    return { reason: "api_access_pending", service: pending.metadata?.service };
  }
  if (status === 401) return { reason: "reconnect" };
  if (status === 403) return { reason: "permission_denied" };
  if (status === 429) return { reason: "rate_limited" };
  return { reason: "other" };
}

function messageFor(reason: GbpErrorReason, status: number, service?: string) {
  switch (reason) {
    case "api_access_pending":
      return `Google has not opened ${service ?? "the Business Profile APIs"} to this Google Cloud project yet: the API is disabled or its quota is 0 until Google approves the Business Profile API access request.`;
    case "reconnect":
      return "The Google Business Profile connection expired or was revoked.";
    case "permission_denied":
      return "Google denied access to this Business Profile account or location.";
    case "rate_limited":
      return "Google Business Profile rate limit reached. Retry in a minute.";
    default:
      return `Google Business Profile API error (${status}).`;
  }
}

async function toApiError(response: Response): Promise<GbpApiError> {
  const body = await response
    .text()
    .then((text) => text.slice(0, MAX_ERROR_BODY_LENGTH))
    .catch(() => "");
  let details: Array<{ reason?: string; metadata?: Record<string, string> }> =
    [];
  try {
    const parsed = googleErrorSchema.safeParse(JSON.parse(body));
    if (parsed.success) details = parsed.data.error.details ?? [];
  } catch {
    // Non-JSON error pages collapse to a status-only error.
  }
  const { reason, service } = classifyError(response.status, details);
  return new GbpApiError(
    response.status,
    messageFor(reason, response.status, service),
    reason,
  );
}

/** Follows nextPageToken until `max` items are collected or pages run out. */
async function collectPages<T>(
  max: number,
  fetchPage: (
    pageToken: string | undefined,
  ) => Promise<{ items: T[]; nextPageToken?: string }>,
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const page = await fetchPage(pageToken);
    items.push(...page.items);
    pageToken = page.nextPageToken || undefined;
  } while (pageToken && items.length < max);
  return items.slice(0, max);
}

export function createGbpClient(opts: {
  userId: string;
  googleAccountId: string;
}) {
  let tokenPromise: Promise<string> | undefined;
  const accessToken = () =>
    (tokenPromise ??= getGoogleAccessToken({
      providerId: GBP_OAUTH_PROVIDER_ID,
      userId: opts.userId,
      accountId: opts.googleAccountId,
    }).catch((error: unknown) => {
      throw new GbpTokenError(
        "Could not mint a Google Business Profile access token.",
        error,
      );
    }));

  async function get(url: URL | string): Promise<unknown> {
    const token = await accessToken();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new GbpApiError(
        0,
        "Google Business Profile is temporarily unavailable.",
        "other",
      );
    }
    if (!response.ok) throw await toApiError(response);
    return response.json();
  }

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
      const parent = `${gbpAccountNameSchema.parse(input.accountName)}/${gbpLocationNameSchema.parse(input.location)}`;
      let summary: { averageRating: number | null; totalReviewCount: number } =
        { averageRating: null, totalReviewCount: 0 };
      const reviews = await collectPages<GbpReview>(
        input.max,
        async (pageToken) => {
          const url = new URL(`${REVIEWS_API_BASE}/${parent}/reviews`);
          url.searchParams.set("pageSize", "50");
          url.searchParams.set("orderBy", input.orderBy);
          if (pageToken) url.searchParams.set("pageToken", pageToken);
          const page = reviewsResponseSchema.parse(await get(url));
          summary = {
            averageRating: page.averageRating ?? null,
            totalReviewCount: page.totalReviewCount ?? 0,
          };
          return {
            items: (page.reviews ?? []).map((review) => ({
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
            })),
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
  };
}
