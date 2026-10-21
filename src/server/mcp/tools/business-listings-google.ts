import type { Hours } from "@/server/features/gbp/services/gbpListingShapes";
import { GBP_DAYS } from "@/server/features/gbp/services/gbpListingShapes";
import { GbpOwnListingService } from "@/server/features/gbp/services/GbpOwnListingService";
import { GbpService } from "@/server/features/gbp/services/GbpService";
import { AppError } from "@/server/lib/errors";
import type { GbpLocation } from "@/server/lib/gbpClient";
import {
  GbpApiError,
  GbpNotConnectedError,
  GbpTokenError,
} from "@/server/lib/gbpErrors";
import { fetchPlaceDetails } from "@/server/lib/googlePlaces";
import { getGoogleFallbackKey } from "@/server/lib/runtime-env";
import { formatMcpCell } from "@/server/mcp/table";
import { GBP_STORAGE_NOTE } from "@/server/mcp/tools/business-profile-format";
import {
  cidFromMapsUri,
  placesLocale,
  placesNotes,
  placesResponseFields,
  toLocalRow,
} from "@/server/mcp/tools/local-seo-places";
import { resolveBusinessIdentifier } from "@/server/mcp/tools/local-seo-shared";
import { formatVisitDate } from "@/server/mcp/tools/place-details";
import { safeHostname } from "@/shared/safe-url";

// get_business_profile, get_business_reviews and get_business_updates on a
// self-hosted install without DataForSEO. A place ID or cid of one of the
// project's own Business Profile locations is read through Business Profile:
// every review, so the star breakdown, the photo count and the posts. Any
// other business is read live from Google Places Place Details, which has no
// star breakdown, claim status, photo count or posts, and at most 5 reviews.
// Rows keep DataForSEO's field names, with null where Google has no value, so
// local-seo-tools renders them as it renders DataForSEO's.

type PlaceIdentifier = { placeId?: string; cid?: string };
type IdentifierArgs = { businessName?: string; cid?: string; placeId?: string };
type LocaleContext = {
  project: { locationCode: number; languageCode: string };
};

const NAME_NOT_SUPPORTED =
  "Without DataForSEO this server looks businesses up by placeId or cid, not businessName: list_google_business_profile_locations gives your own locations' place IDs, and search_local_businesses or get_local_serp_results rows give other businesses' place_id.";

const TASK_ID_NOT_SUPPORTED =
  "taskId resumes a DataForSEO task, and this server reads Google directly: call again without taskId.";

const OWN_SOURCE_NOTE =
  "Source: your Google Business Profile (owner view), read live.";

const PLACES_SOURCE_NOTE =
  "Source: Google Maps (Places API Place Details), fetched live for this call.";

const PLACES_PROFILE_NOTE =
  "Google Places has no star breakdown, claim status, photo count or additional categories, so they are null here. get_place_details also says whether the place offers delivery, dine-in, takeout and reservations.";

const PLACES_REVIEWS_NOTE =
  "Google Places returns at most 5 reviews, in its own relevance order, and no owner replies, so sortBy and depth do not apply. Review text is Google Maps content: never copy it into save_report or update_project_context.";

const CLOSED_STATUS: Record<string, string> = {
  CLOSED_TEMPORARILY: "temporarily_closed",
  CLOSED_PERMANENTLY: "closed_forever",
};

const REVIEW_ORDER = {
  newest: "newest",
  highest_rating: "highest",
  lowest_rating: "lowest",
  // Business Profile has no relevance order.
  relevant: "newest",
} as const;

function placeIdentifier(args: IdentifierArgs): PlaceIdentifier {
  const identifier = resolveBusinessIdentifier(args);
  if (identifier.keyword != null) {
    throw new AppError("VALIDATION_ERROR", NAME_NOT_SUPPORTED);
  }
  return { placeId: identifier.placeId, cid: identifier.cid };
}

const isPlace = (location: GbpLocation, place: PlaceIdentifier) =>
  place.placeId != null
    ? location.placeId === place.placeId
    : cidFromMapsUri(location.mapsUri ?? undefined) === place.cid;

/**
 * Runs `read` on the project's Business Profile location with this place ID
 * or cid. `own` is null when none matches, or when Business Profile cannot be
 * read; `why` then says why.
 */
async function readOwnListing<T>(
  projectId: string,
  place: PlaceIdentifier,
  read: (location: GbpLocation) => Promise<T>,
): Promise<{ own: T | null; why: string | null }> {
  try {
    const { locations } = await GbpService.listLocations(projectId);
    const match = locations.find((location) => isPlace(location, place));
    return { own: match ? await read(match) : null, why: null };
  } catch (error) {
    if (error instanceof GbpNotConnectedError) {
      return {
        own: null,
        why: "Business Profile is not connected to this project",
      };
    }
    if (error instanceof GbpTokenError || error instanceof GbpApiError) {
      console.warn("[business-listings] Business Profile read failed:", error);
      return {
        own: null,
        why: `Business Profile could not be read (${error.message.replace(/\.$/, "")})`,
      };
    }
    throw error;
  }
}

function publicListingNote(why: string | null): string[] {
  return why
    ? [
        `${why}, so this is the public Google Maps listing. For your own listings, Business Profile gives every review, the star breakdown, the photo count and your posts.`,
      ]
    : [];
}

/** The public listing of a business that is not one of the project's own. */
async function fetchPublicPlace(
  place: PlaceIdentifier,
  languageCode: string | undefined,
  context: LocaleContext,
  why: string | null,
) {
  const prefix = why ? `${why}. ` : "";
  if (place.placeId == null) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${prefix}Google Places looks other businesses up by place ID only: pass placeId (place_id in search_local_businesses or get_local_serp_results rows).`,
    );
  }
  const apiKey = await getGoogleFallbackKey("GOOGLE_PLACES_API_KEY");
  if (!apiKey) {
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      `${prefix}Other businesses need GOOGLE_PLACES_API_KEY on this server (see docs/SELF_HOSTING_GOOGLE_APIS.md); your own listings need Business Profile connected to the project.`,
    );
  }
  return fetchPlaceDetails(apiKey, {
    placeId: place.placeId,
    ...placesLocale(
      languageCode ?? context.project.languageCode,
      context.project,
    ),
  });
}

function clock(hhmm: string) {
  const [hour = 0, minute = 0] = hhmm.split(":").map(Number);
  return { hour, minute };
}

/** Business Profile hours as DataForSEO's work_hours timetable. */
function toTimetable(hours: Hours[]) {
  if (hours.length === 0) return null;
  return Object.fromEntries(
    GBP_DAYS.map((day) => [
      day.toLowerCase(),
      hours
        .filter((period) => period.day === day)
        .map((period) => ({
          open: clock(period.open),
          close: clock(period.close),
        })),
    ]),
  );
}

export async function readGoogleBusinessProfile(
  args: IdentifierArgs & { projectId: string; languageCode?: string },
  context: LocaleContext,
) {
  const place = placeIdentifier(args);
  const { own, why } = await readOwnListing(args.projectId, place, (location) =>
    GbpOwnListingService.getProfile({
      projectId: args.projectId,
      location: location.location,
    }),
  );

  if (own) {
    const { location, listing, media } = own;
    const sampled = own.ratingCountsFrom < own.totalReviewCount;
    return {
      profile: {
        title: location.title,
        category: listing.primaryCategory?.displayName ?? null,
        additional_categories: listing.additionalCategories.map(
          (category) => category.displayName ?? category.name,
        ),
        rating: { value: own.averageRating, votes_count: own.totalReviewCount },
        rating_distribution: own.ratingCounts,
        address: location.address,
        phone: listing.primaryPhone,
        url: listing.websiteUri,
        domain: safeHostname(listing.websiteUri),
        // Business Profile's "voice of merchant": a verified owner.
        is_claimed: own.verified,
        work_time: {
          work_hours: {
            current_status: CLOSED_STATUS[listing.openStatus ?? ""] ?? null,
            timetable: toTimetable(listing.regularHours),
          },
        },
        total_photos: media.owner + media.customers,
        photos: media,
        cid: cidFromMapsUri(location.mapsUri ?? undefined),
        place_id: location.placeId,
        check_url: location.mapsUri,
      },
      notes: [
        `${OWN_SOURCE_NOTE} Rating breakdown from ${sampled ? `the newest ${own.ratingCountsFrom} of ${own.totalReviewCount}` : `all ${own.ratingCountsFrom}`} reviews. Photos and videos: ${media.owner} from the owner, ${media.customers} from customers.`,
        GBP_STORAGE_NOTE,
      ],
      fields: { provider: "google_business_profile" },
    };
  }

  const details = await fetchPublicPlace(
    place,
    args.languageCode,
    context,
    why,
  );
  const fields = placesResponseFields(details.budget, [details.place]);
  const { work_hours, ...row } = toLocalRow(details.place);
  return {
    profile: {
      ...row,
      additional_categories: null,
      rating_distribution: null,
      is_claimed: null,
      total_photos: null,
      work_time: { work_hours },
    },
    notes: [
      ...publicListingNote(why),
      PLACES_PROFILE_NOTE,
      ...placesNotes(fields, PLACES_SOURCE_NOTE),
    ],
    fields,
  };
}

export async function readGoogleBusinessReviews(
  args: IdentifierArgs & {
    projectId: string;
    languageCode?: string;
    depth?: number;
    sortBy?: keyof typeof REVIEW_ORDER;
    includeOtherSources?: boolean;
    taskId?: string;
  },
  context: LocaleContext,
) {
  if (args.taskId)
    throw new AppError("VALIDATION_ERROR", TASK_ID_NOT_SUPPORTED);
  const place = placeIdentifier(args);
  const sortBy = args.sortBy ?? "newest";
  const otherSourcesNote = args.includeOtherSources
    ? [
        "includeOtherSources does not apply: Google's APIs return Google reviews only.",
      ]
    : [];
  const { own, why } = await readOwnListing(
    args.projectId,
    place,
    async (location) => ({
      location,
      page: await GbpService.getReviews({
        projectId: args.projectId,
        location: location.location,
        projectDomain: null,
        orderBy: REVIEW_ORDER[sortBy],
        limit: args.depth ?? 20,
        unansweredOnly: false,
      }),
    }),
  );

  if (own) {
    const { location, page } = own;
    return {
      reviews: page.reviews.map((review, index) => ({
        rank_absolute: index + 1,
        timestamp: review.createTime,
        rating: { value: review.rating },
        review_text: review.comment,
        profile_name: review.reviewer,
        owner_answer: review.reply?.comment ?? null,
        owner_timestamp: review.reply?.updateTime ?? null,
        review_id: review.reviewId,
      })),
      totals: {
        title: page.title,
        reviews_count: page.totalReviewCount,
        rating: {
          value: page.averageRating,
          votes_count: page.totalReviewCount,
        },
        cid: cidFromMapsUri(location.mapsUri ?? undefined),
        place_id: location.placeId,
      },
      ownerReplies: true,
      notes: [
        `${OWN_SOURCE_NOTE} Sorted ${REVIEW_ORDER[sortBy]} first${sortBy === "relevant" ? " (Business Profile has no relevance order)" : ""}; ${page.unansweredCount} of the ${page.fetchedCount} fetched have no owner reply.`,
        ...otherSourcesNote,
        GBP_STORAGE_NOTE,
      ],
      fields: { provider: "google_business_profile" },
    };
  }

  const details = await fetchPublicPlace(
    place,
    args.languageCode,
    context,
    why,
  );
  const fields = placesResponseFields(details.budget, [details.place]);
  const reviews = (details.place.reviews ?? []).map((review, index) => ({
    rank_absolute: index + 1,
    time_ago: review.relativePublishTimeDescription ?? null,
    timestamp: review.publishTime ?? null,
    rating: { value: review.rating ?? null },
    // The author's own words; Google's translation is only in `text`.
    review_text: review.originalText?.text ?? review.text?.text ?? null,
    profile_name: review.authorAttribution?.displayName ?? null,
    profile_url: review.authorAttribution?.uri ?? null,
    profile_image_url: review.authorAttribution?.photoUri ?? null,
    review_url: review.googleMapsUri ?? null,
    visit_date: formatVisitDate(review.visitDate),
  }));
  // Google requires each review shown to credit its author (avatar, name,
  // profile link) and Google Maps, and most clients pass on only the text.
  const credits = reviews.map(
    (review) =>
      `${review.rank_absolute}. ${formatMcpCell(review.profile_name)} (${formatMcpCell(review.profile_url)}, avatar ${formatMcpCell(review.profile_image_url)}), review on Google Maps: ${formatMcpCell(review.review_url)}${review.visit_date ? `, visited ${review.visit_date}` : ""}`,
  );
  return {
    reviews,
    totals: {
      title: details.place.displayName?.text ?? null,
      reviews_count: details.place.userRatingCount ?? null,
      rating: {
        value: details.place.rating ?? null,
        votes_count: details.place.userRatingCount ?? null,
      },
      cid: cidFromMapsUri(details.place.googleMapsUri),
      place_id: details.place.id,
    },
    ownerReplies: false,
    notes: [
      ...publicListingNote(why),
      PLACES_REVIEWS_NOTE,
      ...otherSourcesNote,
      ...(credits.length > 0
        ? [
            "When you show or quote a review, credit its author and Google Maps:",
            ...credits,
          ]
        : []),
      ...placesNotes(fields, PLACES_SOURCE_NOTE),
    ],
    fields,
  };
}

export async function readGoogleBusinessUpdates(
  args: IdentifierArgs & { projectId: string; depth?: number; taskId?: string },
) {
  if (args.taskId)
    throw new AppError("VALIDATION_ERROR", TASK_ID_NOT_SUPPORTED);
  const place = placeIdentifier(args);
  const { own, why } = await readOwnListing(args.projectId, place, (location) =>
    GbpOwnListingService.getPosts({
      projectId: args.projectId,
      location: location.location,
      max: args.depth ?? 10,
    }),
  );
  if (!own) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${why ?? "That business is not a location of the project's connected Business Profile account"}. Without DataForSEO, get_business_updates reads only your own listings, through Business Profile: Google has no API for another business's posts, so open its Google Maps listing to see them.`,
    );
  }
  return {
    updates: own.posts.map((post, index) => ({
      rank_absolute: index + 1,
      post_date: post.createTime,
      post_text: post.summary,
      url: post.searchUrl,
      topic_type: post.topicType,
      state: post.state,
    })),
    notes: [
      `${OWN_SOURCE_NOTE} Post text is cut to its first 200 characters.`,
      GBP_STORAGE_NOTE,
    ],
    fields: { provider: "google_business_profile" },
  };
}
