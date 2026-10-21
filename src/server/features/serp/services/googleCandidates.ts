import { waitUntil } from "cloudflare:workers";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import {
  fetchBrightDataSerp,
  type BrightDataSerp,
} from "@/server/lib/brightDataSerp";
import { domainOf } from "@/server/lib/brightDataSerpSections";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import { normalizeAiSuggestion } from "@/shared/ai-prompt-suggestions";
import {
  googleSearchCandidatesSchema,
  type GoogleSearchCandidates,
} from "@/types/schemas/googleCandidates";

// A repeat within this window, such as asking for prompt ideas twice or
// refetching a related keyword search, sends no request. A week is fresh
// enough for competitors, People Also Ask and related searches.
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

type Market = {
  locationCode: number;
  languageCode: string;
  locationName?: string | null;
};

/**
 * Where a project's own live searches run: its country and language, near
 * the city of its rank tracker in that market when it has one, so a local
 * business sees its city's local pack. The tracker (preferring one with a
 * city) also says which keywords the project follows, and on which device:
 * mobile when it checks mobile only, so its next scheduled check can reuse
 * a page fetched on that device.
 */
export async function projectSearchTracker(project: {
  id: string;
  locationCode: number;
  languageCode: string;
}) {
  const trackers = (
    await RankTrackingRepository.getConfigsForProject(project.id)
  ).filter(
    (tracker) =>
      tracker.locationCode === project.locationCode &&
      tracker.languageCode === project.languageCode,
  );
  const tracker =
    trackers.find((candidate) => candidate.locationName) ?? trackers[0];
  return {
    market: {
      locationCode: project.locationCode,
      languageCode: project.languageCode,
      locationName: tracker?.locationName ?? null,
    },
    trackerId: tracker?.id ?? null,
    device:
      tracker?.devices === "mobile"
        ? ("mobile" as const)
        : ("desktop" as const),
  };
}

/**
 * The first Google results page for one query from Bright Data (one request
 * from the server's monthly budget, saved to the organization's SERP store),
 * reduced to the candidates a person or their AI agent picks from. Every
 * feature that reads Google's candidates goes through here, so they share
 * one cache per organization, query, market and device.
 */
export async function searchGoogleCandidates(
  config: BrightDataSerp,
  input: {
    query: string;
    market: Market;
    organizationId: string;
    /** Desktop unless set, as DataForSEO searches. */
    device?: "desktop" | "mobile";
  },
): Promise<GoogleSearchCandidates> {
  const device = input.device ?? "desktop";
  const cacheKey = await buildCacheKey("serp:candidates", {
    organizationId: input.organizationId,
    query: normalizeAiSuggestion(input.query),
    locationCode: input.market.locationCode,
    languageCode: input.market.languageCode,
    locationName: input.market.locationName ?? null,
    device,
  });
  const cached = googleSearchCandidatesSchema.safeParse(
    await getCached(cacheKey),
  );
  if (cached.success) return cached.data;

  const serp = await fetchBrightDataSerp(config, {
    keyword: input.query,
    market: input.market,
    device,
    depth: 10,
    observation: { organizationId: input.organizationId, origin: "research" },
  });
  const candidates: GoogleSearchCandidates = {
    query: input.query,
    locationName: input.market.locationName ?? null,
    organic: serp.organic.map(({ title, url, domain, description }) => ({
      title,
      url,
      domain,
      description,
    })),
    localPack: serp.localPack.map((item) => ({
      name: item.title,
      url: item.url,
      domain: domainOf(item.url),
      rating: item.rating,
      reviewsCount: item.reviewsCount,
    })),
    peopleAlsoAsk: serp.peopleAlsoAsk,
    relatedSearches: serp.relatedSearches,
  };
  // waitUntil, not void: workerd cancels unregistered pending I/O once the
  // response is sent.
  waitUntil(
    setCached(cacheKey, candidates, CACHE_TTL_SECONDS).catch((error) => {
      console.error("serp.candidates.cache-write failed:", error);
    }),
  );
  return candidates;
}
