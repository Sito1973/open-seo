import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { normalizeDomainInput } from "@/server/lib/domainUtils";
import { AppError } from "@/server/lib/errors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { requireProjectContext } from "@/serverFunctions/middleware";

/**
 * Ahrefs' free Domain Rating endpoint enriches the Backlinks tables on demand:
 * no billing, no stored data. It needs the APIv3 key of a free Ahrefs account
 * (AHREFS_API_KEY); without one nothing is sent. Ahrefs' license requires the
 * "Domain Rating by Ahrefs" attribution wherever the values show. Every
 * result (a DR, or `null` when Ahrefs has no rating) is cached in KV for a day
 * so re-opening the table is free.
 */
const AHREFS_DR_ENDPOINT =
  "https://api.ahrefs.com/v3/public/domain-rating-free";
const CACHE_PREFIX = "ahrefs-dr:";
const CACHE_TTL_SECONDS = 86_400; // 24 hours
const FETCH_TIMEOUT_MS = 10_000;
// Ahrefs takes up to 1,000 targets per request; the KV reads and writes per
// domain keep each call to 100.
const MAX_DOMAINS_PER_CALL = 100;

const domainRatingsInputSchema = z.object({
  projectId: z.string().min(1),
  domains: z.array(z.string().trim().min(1).max(253)).max(MAX_DOMAINS_PER_CALL),
});

const ahrefsResponseSchema = z.object({
  domain_rating: z.object({
    targets: z.array(
      z.object({
        target: z.string(),
        domain_rating: z.number().min(0).max(100),
      }),
    ),
  }),
});

export const getAhrefsDomainRatings = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(domainRatingsInputSchema)
  .handler(async ({ data }) => {
    const apiKey = await getOptionalEnvValue("AHREFS_API_KEY");
    if (!apiKey) {
      throw new AppError(
        "PROVIDER_NOT_CONFIGURED",
        "AHREFS_API_KEY is not set, so no Ahrefs Domain Rating was requested.",
      );
    }

    // Several original inputs can collapse to one normalized domain (www/non-www,
    // protocol variants). Resolve each normalized domain once, then fan the value
    // back out to every original key the client will look up by.
    const originalsByDomain = new Map<string, string[]>();
    for (const original of data.domains) {
      const domain = normalizeDomainInput(original, true);
      const existing = originalsByDomain.get(domain);
      if (existing) existing.push(original);
      else originalsByDomain.set(domain, [original]);
    }

    // KV returns JS `null` only when the key is absent; a cached "no rating" is
    // stored as the string "null", so cache hits (including nulls) skip Ahrefs.
    // A KV blip only costs a cache hit, never the whole call.
    const ratings = new Map<string, number | null>();
    const cached = await Promise.all(
      [...originalsByDomain.keys()].map(
        async (domain) =>
          [
            domain,
            await env.KV.get(`${CACHE_PREFIX}${domain}`).catch(() => null),
          ] as const,
      ),
    );
    const uncached: string[] = [];
    for (const [domain, raw] of cached) {
      if (raw === null) uncached.push(domain);
      else ratings.set(domain, parseCachedRating(raw));
    }

    if (uncached.length > 0) {
      const fetched = await fetchDomainRatings(apiKey, uncached);
      await Promise.all(
        uncached.map(async (domain) => {
          const dr = fetched.get(domain) ?? null;
          ratings.set(domain, dr);
          await env.KV.put(`${CACHE_PREFIX}${domain}`, JSON.stringify(dr), {
            expirationTtl: CACHE_TTL_SECONDS,
          }).catch(() => undefined);
        }),
      );
    }

    const result: Record<string, number | null> = {};
    for (const [domain, originals] of originalsByDomain) {
      const dr = ratings.get(domain) ?? null;
      for (const original of originals) result[original] = dr;
    }
    return result;
  });

/** One request for every domain; a domain Ahrefs leaves out has no rating. */
async function fetchDomainRatings(
  apiKey: string,
  domains: string[],
): Promise<Map<string, number | null>> {
  const response = await fetch(AHREFS_DR_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ targets: domains }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AppError(
      "PROVIDER_NOT_CONFIGURED",
      `Ahrefs refused AHREFS_API_KEY (HTTP ${response.status}).`,
    );
  }
  if (!response.ok) {
    console.warn(`[ahrefs] Domain Rating lookup failed: ${response.status}`);
    throw new AppError(
      response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
      `Ahrefs Domain Rating lookup failed with status ${response.status}`,
    );
  }

  const parsed = ahrefsResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Ahrefs Domain Rating lookup returned an unexpected response",
    );
  }

  // Targets come back as sent: normalized, lowercase, without www. Ahrefs
  // answers DR 0 for domains it has no rating for (new or unknown), so treat
  // 0 as "no rating" — the table renders it as "—".
  return new Map(
    parsed.data.domain_rating.targets.map((item) => [
      item.target
        .trim()
        .toLowerCase()
        .replace(/^www\./, ""),
      item.domain_rating > 0 ? item.domain_rating : null,
    ]),
  );
}

function parseCachedRating(raw: string): number | null {
  try {
    const value: unknown = JSON.parse(raw);
    // Mirror fetchDomainRatings: a DR of 0 means "no rating", so render it as "—".
    return typeof value === "number" && value > 0 ? value : null;
  } catch {
    return null;
  }
}
