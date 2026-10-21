import {
  requireSelfHosted,
  resolveLocation,
} from "@/server/features/gbp/services/GbpService";
import { toListing } from "@/server/features/gbp/services/gbpListingShapes";

// One of the owner's own listings, read through Business Profile for the
// local-SEO tools that also read other businesses (get_business_profile,
// get_business_updates) on a self-hosted install without DataForSEO.
// Business Profile has what Google Places lacks: every review, so a star
// breakdown, the photo count and the posts.

// The breakdown pages through every review, 50 at a time, newest first. Past
// this many it covers the newest ones only, so the call stays well under a
// minute.
const RATING_BREAKDOWN_MAX_REVIEWS = 3000;

async function getProfile(input: { projectId: string; location: string }) {
  await requireSelfHosted();
  const { connection, client, location } = await resolveLocation({
    ...input,
    projectDomain: null,
  });
  const v4 = {
    accountName: connection.accountName,
    location: location.location,
  };
  const [raw, media, reviews] = await Promise.all([
    client.getLocation(location.location),
    client.countMedia(v4),
    client.listReviews({
      ...v4,
      orderBy: "updateTime desc",
      max: RATING_BREAKDOWN_MAX_REVIEWS,
    }),
  ]);
  const ratingCounts: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const review of reviews.reviews) {
    if (review.rating) ratingCounts[review.rating] += 1;
  }
  return {
    location,
    listing: toListing(raw),
    verified: raw.metadata?.hasVoiceOfMerchant ?? false,
    averageRating: reviews.averageRating,
    totalReviewCount: reviews.totalReviewCount,
    ratingCounts,
    ratingCountsFrom: reviews.reviews.length,
    media,
  };
}

async function getPosts(input: {
  projectId: string;
  location: string;
  max: number;
}) {
  await requireSelfHosted();
  const { connection, client, location } = await resolveLocation({
    ...input,
    projectDomain: null,
  });
  const posts = await client.listLocalPosts({
    accountName: connection.accountName,
    location: location.location,
    max: input.max,
  });
  return { location, posts };
}

export const GbpOwnListingService = { getProfile, getPosts };
