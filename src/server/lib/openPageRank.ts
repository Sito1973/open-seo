import { chunk, unique } from "remeda";
import { getDomain } from "tldts";
import { z } from "zod";
import { GooglePlacesUsageRepository } from "@/server/features/google-places/repositories/GooglePlacesUsageRepository";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import { getGoogleFallbackKey } from "@/server/lib/runtime-env";

// Open PageRank (Keywords Everywhere): a free 0-10 authority score per
// registered domain, from Common Crawl's link graph. It feeds the organic part
// of OpenSEO's keyword difficulty estimates on self-hosted installs without
// DataForSEO. The URL is a fixed provider host, so no SSRF screening applies.
// https://keywordseverywhere.com/openpagerank/docs
const REQUEST_URL =
  "https://openpagerank.keywordseverywhere.com/v1/domains/bulk";
const DOMAINS_PER_REQUEST = 100;
const REQUEST_TIMEOUT_MS = 30_000;

// The free plan counts 30,000 unique domains a month; this stays under it.
// There is deliberately no setting to raise it.
export const OPEN_PAGERANK_MONTHLY_DOMAINS = 25_000;

// Scores move with Common Crawl releases, about monthly, so each domain's is
// kept 30 days.
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

const cachedScoreSchema = z.object({ openPageRank: z.number().nullable() });

const responseSchema = z.object({
  results: z.array(
    z.object({
      domain: z.string(),
      // Null when Open PageRank does not know the domain.
      open_page_rank: z.number().min(0).max(10).nullable().catch(null),
    }),
  ),
});

const errorSchema = z.object({
  error: z.object({ type: z.string(), message: z.string().max(500) }),
});

type OpenPageRanks =
  | { scores: Map<string, number | null>; unavailable: null }
  | { scores: null; unavailable: string };

function cacheKey(domain: string) {
  return buildCacheKey("openpagerank", { domain });
}

async function requestScores(apiKey: string, domains: string[]) {
  let response: Response;
  try {
    response = await fetch(REQUEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ domains, include_history: false }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("[openpagerank] request failed:", error);
    throw new Error("Open PageRank could not be reached.", { cause: error });
  }
  if (!response.ok) {
    const body = errorSchema.safeParse(await response.json().catch(() => null));
    const detail = body.success
      ? `${body.data.error.type}: ${body.data.error.message}`
      : `HTTP ${response.status}`;
    console.warn(`[openpagerank] HTTP ${response.status}: ${detail}`);
    throw new Error(
      body.success && body.data.error.type === "address_error"
        ? "Open PageRank refused this server's IP address: a free key answers only the IPv4 address set on its account page."
        : `Open PageRank refused the request (${detail}).`,
    );
  }
  const parsed = responseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    console.warn("[openpagerank] unexpected response:", parsed.error.message);
    throw new Error("Open PageRank returned an unexpected response.");
  }
  return new Map(
    parsed.data.results.map((row) => [
      row.domain.toLowerCase(),
      row.open_page_rank,
    ]),
  );
}

/**
 * Open PageRank (0-10) of each host's registered domain, keyed by the host as
 * given, null for a domain Open PageRank does not know. Each domain's score is
 * cached 30 days; the others are reserved from the monthly domain budget and
 * fetched 100 at a time. Without a key, past the budget or when a request
 * fails, there are no scores and `unavailable` says why, so a caller leaves
 * authority out rather than guessing it.
 */
export async function fetchOpenPageRanks(
  hosts: string[],
): Promise<OpenPageRanks> {
  // Null on hosted, next to DataForSEO for other features, or when unset.
  const apiKey = await getGoogleFallbackKey("OPENPAGERANK_API_KEY");
  if (!apiKey) {
    return {
      scores: null,
      unavailable: "OPENPAGERANK_API_KEY is not set on this server.",
    };
  }
  const registered = (host: string) => getDomain(host) ?? host;
  const byDomain = new Map<string, number | null>();
  const missing: string[] = [];
  for (const domain of unique(hosts.map(registered))) {
    const cached = cachedScoreSchema.safeParse(
      await getCached(await cacheKey(domain)),
    );
    if (cached.success) byDomain.set(domain, cached.data.openPageRank);
    else missing.push(domain);
  }

  if (missing.length > 0) {
    const month = new Date().toISOString().slice(0, 7);
    const used = await GooglePlacesUsageRepository.reserveCalls({
      month,
      sku: "open_pagerank",
      count: missing.length,
      limit: OPEN_PAGERANK_MONTHLY_DOMAINS,
    });
    if (used == null) {
      return {
        scores: null,
        unavailable: `This server's monthly Open PageRank budget (${OPEN_PAGERANK_MONTHLY_DOMAINS} domains in ${month}, UTC) is used up. It resets on the 1st.`,
      };
    }
    try {
      for (const domains of chunk(missing, DOMAINS_PER_REQUEST)) {
        const fetched = await requestScores(apiKey, domains);
        for (const domain of domains) {
          const score = fetched.get(domain) ?? null;
          byDomain.set(domain, score);
          await setCached(
            await cacheKey(domain),
            { openPageRank: score },
            CACHE_TTL_SECONDS,
          );
        }
      }
    } catch (error) {
      return {
        scores: null,
        unavailable:
          error instanceof Error ? error.message : "Open PageRank failed.",
      };
    }
  }

  return {
    scores: new Map(
      hosts.map((host) => [host, byDomain.get(registered(host)) ?? null]),
    ),
    unavailable: null,
  };
}
