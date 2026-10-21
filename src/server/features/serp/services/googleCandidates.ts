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

// A repeat within this window, such as asking for prompt ideas twice, sends
// no request.
const CACHE_TTL_SECONDS = 12 * 60 * 60;

type Market = {
  locationCode: number;
  languageCode: string;
  locationName?: string | null;
};

/**
 * Where a project's own live searches run: its country and language, near
 * the city of its rank tracker in that market when it has one, so a local
 * business sees its city's local pack. The tracker (preferring one with a
 * city) also says which keywords the project follows.
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
  };
}

/**
 * The first Google results page for one query from Bright Data (one request
 * from the server's monthly budget, saved to the organization's SERP store),
 * reduced to the candidates a person or their AI agent picks from.
 */
export async function searchGoogleCandidates(
  config: BrightDataSerp,
  input: { query: string; market: Market; organizationId: string },
): Promise<GoogleSearchCandidates> {
  const cacheKey = await buildCacheKey("serp:candidates", {
    organizationId: input.organizationId,
    query: normalizeAiSuggestion(input.query),
    locationCode: input.market.locationCode,
    languageCode: input.market.languageCode,
    locationName: input.market.locationName ?? null,
  });
  const cached = googleSearchCandidatesSchema.safeParse(
    await getCached(cacheKey),
  );
  if (cached.success) return cached.data;

  const serp = await fetchBrightDataSerp(config, {
    keyword: input.query,
    market: input.market,
    device: "desktop",
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
    peopleAlsoAsk: serp.peopleAlsoAsk.map((item) => item.question),
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
