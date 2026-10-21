import { z } from "zod";
import { GooglePlacesUsageRepository } from "@/server/features/google-places/repositories/GooglePlacesUsageRepository";
import { AppError } from "@/server/lib/errors";

// Places API (New) Text Search: the stand-in for DataForSEO's Maps SERP on
// self-hosted installs without DataForSEO. The URL is a fixed Google host, so
// no SSRF screening applies.
const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 20;
/** Text Search returns at most 60 places (3 pages of 20) for one query. */
export const PLACES_MAX_ROWS = 60;

// Google bills each request at the highest SKU of any field in the mask, so
// these masks set the price. A grid point needs only identity (Text Search
// Pro); a listing adds contact, rating and hours (Text Search Enterprise).
// Never add reviews, photos, editorialSummary or other Atmosphere fields.
// `attributions` and `nextPageToken` are IDs Only and do not raise the SKU.
const GRID_FIELD_MASK =
  "places.id,places.displayName,places.googleMapsUri,places.attributions";
const LISTING_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.primaryTypeDisplayName",
  "places.googleMapsUri",
  "places.businessStatus",
  "places.rating",
  "places.userRatingCount",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.priceLevel",
  "places.regularOpeningHours",
  "places.attributions",
  "nextPageToken",
].join(",");

// Hard-coded below Google's free monthly caps (5,000 Text Search Pro, 1,000
// Text Search Enterprise) so a self-hosted install is never charged. There is
// deliberately no setting to raise them.
const BUDGETS = {
  text_search_pro: { limit: 4500, label: "Text Search Pro" },
  text_search_enterprise: { limit: 900, label: "Text Search Enterprise" },
} as const;

type PlacesSku = keyof typeof BUDGETS;

export type PlacesBudget = {
  sku: PlacesSku;
  usedThisMonth: number;
  limit: number;
};

// proto3 JSON can omit zero values, so a missing day/hour/minute is 0.
const periodPointSchema = z.object({
  day: z.number().int().min(0).max(6).default(0),
  hour: z.number().int().default(0),
  minute: z.number().int().default(0),
});

const localizedTextSchema = z.object({ text: z.string() });

const placeSchema = z.object({
  id: z.string(),
  displayName: localizedTextSchema.optional(),
  formattedAddress: z.string().optional(),
  location: z
    .object({ latitude: z.number(), longitude: z.number() })
    .optional(),
  primaryTypeDisplayName: localizedTextSchema.optional(),
  googleMapsUri: z.string().optional(),
  businessStatus: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
  websiteUri: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  priceLevel: z.string().optional(),
  regularOpeningHours: z
    .object({
      openNow: z.boolean().optional(),
      periods: z
        .array(
          z.object({
            open: periodPointSchema,
            close: periodPointSchema.optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  attributions: z
    .array(
      z.object({
        provider: z.string().optional(),
        providerUri: z.string().optional(),
      }),
    )
    .optional(),
});

export type GooglePlace = z.infer<typeof placeSchema>;

// Google answers an empty result set with `{}`.
const searchTextResponseSchema = z.object({
  places: z.array(placeSchema).default([]),
  nextPageToken: z.string().optional(),
});

const errorResponseSchema = z.object({
  error: z.object({ message: z.string() }),
});

/** Google resets the free caps at the start of each month, Pacific time. */
function billingMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

/**
 * Reserves `count` calls before any request is sent. Failed requests stay
 * counted, which over-counts slightly: the safe direction.
 */
async function reserveBudget(
  sku: PlacesSku,
  count: number,
): Promise<PlacesBudget | null> {
  const month = billingMonth();
  const { limit } = BUDGETS[sku];
  const usedThisMonth = await GooglePlacesUsageRepository.reserveCalls({
    month,
    sku,
    count,
    limit,
  });
  return usedThisMonth == null ? null : { sku, usedThisMonth, limit };
}

function budgetExhausted(sku: PlacesSku, count: number): AppError {
  const { limit, label } = BUDGETS[sku];
  return new AppError(
    "RATE_LIMITED",
    `This server's monthly Google Places budget for ${label} (${limit.toLocaleString("en-US")} calls in ${billingMonth()}) has fewer than ${count} calls left, so no search was sent. It resets next month.`,
  );
}

export function placesBudgetLine(budget: PlacesBudget): string {
  return `Google Places budget: ${budget.usedThisMonth} of ${budget.limit} ${BUDGETS[budget.sku].label} calls used this month (resets on the 1st, Pacific time).`;
}

function placesHttpError(status: number, message: string): AppError {
  if (status === 400) {
    return new AppError(
      "VALIDATION_ERROR",
      `Google Places rejected the request: ${message}`,
    );
  }
  if (status === 401 || status === 403) {
    return new AppError(
      "AUTH_CONFIG_MISSING",
      `Google Places refused GOOGLE_PLACES_API_KEY: ${message} Enable Places API (New) in the key's project, link a billing account, and check the key's API and application restrictions.`,
    );
  }
  if (status === 429) {
    return new AppError(
      "RATE_LIMITED",
      `Google Places quota exceeded: ${message}`,
    );
  }
  return new AppError("UPSTREAM_UNAVAILABLE", `Google Places: ${message}`);
}

async function searchText(
  apiKey: string,
  fieldMask: string,
  body: Record<string, unknown>,
) {
  let response: Response;
  try {
    response = await fetch(SEARCH_TEXT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A header, never ?key=, so the key stays out of logged URLs.
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("[google-places] request failed:", error);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      error instanceof Error && error.name === "TimeoutError"
        ? `Google Places did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
        : "Google Places could not be reached.",
    );
  }

  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(json);
    const message = (
      parsed.success ? parsed.data.error.message : `HTTP ${response.status}`
    ).replaceAll(apiKey, "<api key>");
    console.warn(`[google-places] HTTP ${response.status}: ${message}`);
    throw placesHttpError(response.status, message);
  }

  const parsed = searchTextResponseSchema.safeParse(json);
  if (!parsed.success) {
    console.warn("[google-places] unexpected response:", parsed.error.message);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Google Places returned an unexpected response.",
    );
  }
  return parsed.data;
}

type Locale = { languageCode: string; regionCode: string };
type LatLng = { latitude: number; longitude: number };

/**
 * One Text Search Pro request per grid point, each biased to a circle around
 * the point. The whole grid is reserved up front, so nothing is sent unless
 * every point fits in the budget.
 */
export async function searchGrid(
  apiKey: string,
  input: Locale & { points: LatLng[]; textQuery: string; radiusM: number },
) {
  const budget = await reserveBudget("text_search_pro", input.points.length);
  if (!budget) throw budgetExhausted("text_search_pro", input.points.length);

  const results = await Promise.allSettled(
    input.points.map(async (point) => {
      const page = await searchText(apiKey, GRID_FIELD_MASK, {
        textQuery: input.textQuery,
        languageCode: input.languageCode,
        regionCode: input.regionCode,
        pageSize: PAGE_SIZE,
        locationBias: {
          circle: {
            center: { latitude: point.latitude, longitude: point.longitude },
            radius: input.radiusM,
          },
        },
      });
      return page.places;
    }),
  );
  return { results, budget };
}

/**
 * Text Search Enterprise listings, one reserved call per page of 20. A refused
 * first page fails the call; a refused later page stops pagination and sets
 * `budgetStopped`.
 */
export async function searchListings(
  apiKey: string,
  input: Locale & {
    textQuery: string;
    area:
      | { bias: LatLng & { radiusM: number } }
      | { restriction: { low: LatLng; high: LatLng } };
    maxRows: number;
    minRating?: number;
  },
) {
  const area =
    "bias" in input.area
      ? {
          locationBias: {
            circle: {
              center: {
                latitude: input.area.bias.latitude,
                longitude: input.area.bias.longitude,
              },
              radius: input.area.bias.radiusM,
            },
          },
        }
      : { locationRestriction: { rectangle: input.area.restriction } };

  let budget = await reserveBudget("text_search_enterprise", 1);
  if (!budget) throw budgetExhausted("text_search_enterprise", 1);
  const places: GooglePlace[] = [];
  let budgetStopped = false;
  let pageToken: string | undefined;
  for (;;) {
    // Every field but pageToken and pageSize must repeat across pages.
    const page = await searchText(apiKey, LISTING_FIELD_MASK, {
      textQuery: input.textQuery,
      languageCode: input.languageCode,
      regionCode: input.regionCode,
      minRating: input.minRating,
      ...area,
      pageSize: Math.min(PAGE_SIZE, input.maxRows - places.length),
      pageToken,
    });
    places.push(...page.places);
    pageToken = page.nextPageToken;
    if (!pageToken || places.length >= input.maxRows) break;
    const reserved = await reserveBudget("text_search_enterprise", 1);
    if (!reserved) {
      budgetStopped = true;
      break;
    }
    budget = reserved;
  }

  return { places: places.slice(0, input.maxRows), budget, budgetStopped };
}
