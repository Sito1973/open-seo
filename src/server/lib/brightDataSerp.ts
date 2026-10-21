/* eslint-disable max-lines -- one module per SERP provider (dataforseo/serp.ts precedent): page requests, paging, rank checks and the saved first pages they share */
import { range } from "remeda";
import { z } from "zod";
import { GooglePlacesUsageRepository } from "@/server/features/google-places/repositories/GooglePlacesUsageRepository";
import {
  SerpObservationRepository,
  type SerpObservationOrigin,
} from "@/server/features/serp/repositories/SerpObservationRepository";
import type { RankCheckResult } from "@/server/lib/dataforseo";
import {
  domainOf,
  readSerpSections,
  serpSectionsShape,
} from "@/server/lib/brightDataSerpSections";
import { AppError } from "@/server/lib/errors";
import {
  getGoogleFallbackKey,
  getOptionalEnvValue,
} from "@/server/lib/runtime-env";
import { googleSerpUrl } from "@/shared/google-serp-url";
import { jsonCodec } from "@/shared/json";
import { getIsoCountryCode } from "@/shared/keyword-locations";
import type { BrightDataBudget } from "@/shared/rank-tracking";

// Bright Data's SERP API: the live Google SERP behind rank tracking,
// get_serp_results, find_serp_competitors and Google AI Overviews answers on
// self-hosted installs without DataForSEO. The URL is a fixed provider host,
// so no SSRF screening applies.
const REQUEST_URL = "https://api.brightdata.com/request";
// Bright Data takes 20-50 s per Google page.
const REQUEST_TIMEOUT_MS = 90_000;
/** Google shows about 10 organic results per page; each page is one request. */
const RESULTS_PER_PAGE = 10;
const MAX_PAGES = 10;

// Hard-coded below the free tier's 5,000 requests a month so a self-hosted
// install is never charged. There is deliberately no setting to raise it.
const MONTHLY_BUDGET = 4500;

// A scheduled rank check reuses a first page the organization fetched this
// recently for the same search, so sites that track the same keyword do not
// each pay for it.
const FIRST_PAGE_REUSE_DAYS = 3;

// Bright Data's docs say Google serves every country from google.com with gl
// and hl. From a Colombian exit, though, google.com with gl=co failed with
// "redirect location was rejected" while www.google.com.co answered, so a
// country with a tested domain uses it.
const GOOGLE_HOSTS: Record<string, string> = { co: "www.google.com.co" };

// Parsed SERP sections, named as DataForSEO names the same SERP features so
// rank snapshots read alike from either provider.
const SERP_FEATURES: Record<string, string> = {
  organic: "organic",
  top_ads: "paid",
  bottom_ads: "paid",
  featured_snippets: "featured_snippet",
  people_also_ask: "people_also_ask",
  snack_pack: "local_pack",
  knowledge: "knowledge_graph",
  ai_overview: "ai_overview",
  images: "images",
  videos: "video",
  top_stories: "top_stories",
  shopping: "shopping",
  related: "related_searches",
};

const envelopeSchema = z.object({
  status_code: z.number(),
  headers: z.record(z.string(), z.unknown()).optional(),
  body: z.unknown(),
});

// Fields that only reach the agent drop an unexpected type instead of
// failing the whole page.
const optionalText = z.string().optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);

const serpPageSchema = z.looseObject({
  organic: z
    .array(
      z.object({
        link: optionalText,
        title: optionalText,
        description: optionalText,
      }),
    )
    .default([]),
  // The local pack.
  snack_pack: z
    .array(
      z.object({
        name: optionalText,
        link: optionalText,
        rating: optionalNumber,
        reviews_cnt: optionalNumber,
      }),
    )
    .default([]),
  ...serpSectionsShape,
});

const serpPageCodec = jsonCodec(serpPageSchema);

type SerpPage = z.infer<typeof serpPageSchema>;

type SerpMarket = {
  locationCode: number;
  languageCode: string;
  locationName?: string | null;
};

type Device = "desktop" | "mobile";

type SerpRequest = {
  keyword: string;
  market: SerpMarket;
  device: Device;
  depth: number;
  targetDomain?: string;
  /** Who the first page is saved for in the SERP observation store. */
  observation: { organizationId: string; origin: SerpObservationOrigin };
};

export type BrightDataSerp = { apiKey: string; zone: string };

/**
 * Bright Data stands in for DataForSEO's live Google SERP on self-hosted
 * installs only: null on hosted, next to DATAFORSEO_API_KEY, or unless both
 * BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE are set.
 */
export async function getBrightDataSerp(): Promise<BrightDataSerp | null> {
  const apiKey = await getGoogleFallbackKey("BRIGHTDATA_API_KEY");
  const zone = await getOptionalEnvValue("BRIGHTDATA_SERP_ZONE");
  return apiKey && zone ? { apiKey, zone } : null;
}

function googleTarget(market: SerpMarket) {
  const country = getIsoCountryCode(market.locationCode);
  return { country, host: GOOGLE_HOSTS[country] ?? "www.google.com" };
}

export function brightDataSourceNote(market: SerpMarket): string {
  const { country, host } = googleTarget(market);
  const near = market.locationName ? `, near ${market.locationName}` : "";
  return `Source: Bright Data live Google SERP from ${host} (exit country ${country.toUpperCase()}, language ${market.languageCode}${near}), about 10 organic results per request.`;
}

/** This month's Bright Data requests (UTC) against this server's cap. */
export async function getBrightDataBudget(): Promise<BrightDataBudget> {
  const usedThisMonth = await GooglePlacesUsageRepository.usedCalls({
    month: new Date().toISOString().slice(0, 7),
    sku: "brightdata_serp",
  });
  return { usedThisMonth, monthlyBudget: MONTHLY_BUDGET };
}

export function brightDataBudgetLine(usedThisMonth: number): string {
  return `Bright Data budget: ${usedThisMonth} of ${MONTHLY_BUDGET} SERP requests used this month (resets on the 1st, UTC).`;
}

/**
 * This server's monthly Bright Data budget, which every feature on Bright
 * Data shares, and the requests counted against it this month (UTC).
 */
export async function brightDataBudgetUsage() {
  const usedThisMonth = await GooglePlacesUsageRepository.usedCalls({
    month: new Date().toISOString().slice(0, 7),
    sku: "brightdata_serp",
  });
  return { usedThisMonth, monthlyBudget: MONTHLY_BUDGET };
}

export const BRIGHTDATA_RANK_CHECK_NOTE = `Rank checks on this server run on Bright Data's live Google SERP: each keyword and device sends one request per 10 results of depth, stopping at the page where the tracked domain appears, from this server's monthly budget of ${MONTHLY_BUDGET} requests. A scheduled check reuses the first page of the same search (keyword, market and device) fetched in this organization in the last ${FIRST_PAGE_REUSE_DAYS} days, by any tracker or SERP tool, and sends requests only for the pages after it; a manual check always fetches live.`;

function hostOf(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    return new URL(link).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** `domain` itself or any subdomain, as DataForSEO matches a tracked domain. */
function linkMatchesDomain(link: string | null | undefined, domain: string) {
  const host = hostOf(link);
  const target = domain.toLowerCase();
  return host != null && (host === target || host.endsWith(`.${target}`));
}

/** Features in SERP_FEATURES order, each once, whatever order they came in. */
function orderedFeatures(features: Iterable<string>): string[] {
  const present = new Set(features);
  return [...new Set(Object.values(SERP_FEATURES))].filter((feature) =>
    present.has(feature),
  );
}

function serpFeatures(page: SerpPage): string[] {
  return orderedFeatures(
    Object.entries(SERP_FEATURES)
      .filter(([section]) => {
        const value: unknown = page[section];
        if (Array.isArray(value)) return value.length > 0;
        return typeof value === "object" && value !== null;
      })
      .map(([, feature]) => feature),
  );
}

/**
 * Saves a first page in the organization's SERP observation store. The
 * request is already paid for, so a failed write is logged, never thrown.
 */
async function recordFirstPage(input: SerpRequest, page: SerpPage) {
  try {
    await SerpObservationRepository.record({
      ...input.observation,
      keyword: input.keyword,
      locationCode: input.market.locationCode,
      languageCode: input.market.languageCode,
      locationName: input.market.locationName,
      device: input.device,
      results: [
        ...page.organic.map((item, index) => ({
          section: "organic" as const,
          position: index + 1,
          domain: domainOf(item.link),
          url: item.link ?? null,
          title: item.title ?? null,
        })),
        ...page.snack_pack.map((item, index) => ({
          section: "local_pack" as const,
          position: index + 1,
          domain: domainOf(item.link),
          url: item.link ?? null,
          title: item.name ?? null,
          rating: item.rating ?? null,
          reviewsCount: item.reviews_cnt ?? null,
        })),
      ],
      features: serpFeatures(page),
    });
  } catch (error) {
    console.error("[brightdata] saving the SERP observation failed:", error);
  }
}

function httpError(status: number, detail: string): AppError {
  if (status === 401 || status === 403 || status === 407) {
    return new AppError(
      "AUTH_CONFIG_MISSING",
      `Bright Data refused BRIGHTDATA_API_KEY or BRIGHTDATA_SERP_ZONE: ${detail}. Check the key and that the zone is a SERP API zone.`,
    );
  }
  if (status === 429) {
    return new AppError("RATE_LIMITED", `Bright Data rate limit: ${detail}`);
  }
  return new AppError(
    status >= 500 ? "UPSTREAM_UNAVAILABLE" : "INTERNAL_ERROR",
    `Bright Data: ${detail}`,
  );
}

/**
 * One Google results page. A request is reserved before it is sent; failed
 * requests stay counted, which over-counts slightly: the safe direction.
 */
async function fetchSerpPage(
  config: BrightDataSerp,
  input: { keyword: string; market: SerpMarket; device: Device; start: number },
): Promise<{ page: SerpPage; usedThisMonth: number }> {
  const month = new Date().toISOString().slice(0, 7);
  const usedThisMonth = await GooglePlacesUsageRepository.reserveCalls({
    month,
    sku: "brightdata_serp",
    count: 1,
    limit: MONTHLY_BUDGET,
  });
  if (usedThisMonth == null) {
    throw new AppError(
      "MONTHLY_BUDGET_EXHAUSTED",
      `This server's monthly Bright Data budget (${MONTHLY_BUDGET} SERP requests in ${month}, UTC) is used up, so no request was sent. It resets on the 1st.`,
    );
  }

  const { country, host } = googleTarget(input.market);
  // googleSerpUrl puts q first, as Bright Data asks, then hl, gl, pws=0 and a
  // city's uule. No brd_ai_overview: this zone answered it with a 502.
  let url = googleSerpUrl(input.keyword, input.market).replace(
    "https://www.google.com/",
    `https://${host}/`,
  );
  if (input.start > 0) url += `&start=${input.start}`;
  if (input.device === "mobile") url += "&brd_mobile=1";

  let response: Response;
  try {
    response = await fetch(REQUEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        zone: config.zone,
        url,
        format: "json",
        data_format: "parsed",
        // Without it the exit node can be in any country.
        country,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("[brightdata] request failed:", error);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      error instanceof Error && error.name === "TimeoutError"
        ? `Bright Data did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
        : "Bright Data could not be reached.",
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = (
      response.headers.get("x-brd-error") ||
      body.slice(0, 200) ||
      `HTTP ${response.status}`
    ).replaceAll(config.apiKey, "<api key>");
    console.warn(`[brightdata] HTTP ${response.status}: ${detail}`);
    throw httpError(response.status, detail);
  }

  const envelope = envelopeSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!envelope.success) {
    console.warn("[brightdata] unexpected response:", envelope.error.message);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Bright Data returned an unexpected response.",
    );
  }
  const { status_code: status, headers, body } = envelope.data;
  if (status !== 200) {
    const reason = headers?.["x-brd-error"];
    const detail = typeof reason === "string" ? reason : `HTTP ${status}`;
    console.warn(`[brightdata] Google page failed (${status}): ${detail}`);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      `Bright Data could not fetch the Google results page: ${detail}`,
    );
  }
  const page = serpPageCodec.safeParse(body);
  if (!page.success) {
    console.warn("[brightdata] unexpected SERP body:", page.error.message);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Bright Data returned an unexpected Google results page.",
    );
  }
  return { page: page.data, usedThisMonth };
}

/** Pages already fetched: paging resumes after them. */
type ResumeAfter = { pages: number; organicCount: number };

/**
 * Organic results to `depth`, one request per page of about 10. With
 * `targetDomain`, pages go one at a time and paging stops at the page where
 * that domain ranks; without it, nothing but an empty page ends paging early,
 * so the pages go out at once. Positions count organic results only, in
 * Google's order across pages, and results after an empty page are dropped.
 * The first page is saved to the SERP observation store as soon as it
 * arrives. With `resume`, paging starts after those pages and numbers
 * positions after their organic results.
 */
async function fetchOrganicPages(
  config: BrightDataSerp,
  input: SerpRequest,
  resume: ResumeAfter = { pages: 0, organicCount: 0 },
) {
  const pages = Math.min(
    MAX_PAGES,
    Math.max(1, Math.ceil(input.depth / RESULTS_PER_PAGE)),
  );
  const fetchPage = async (index: number) => {
    const result = await fetchSerpPage(config, {
      ...input,
      start: index * RESULTS_PER_PAGE,
    });
    if (index === 0) await recordFirstPage(input, result.page);
    return result;
  };
  const indexes = range(resume.pages, pages);
  const { targetDomain } = input;
  let fetched: Array<{ page: SerpPage; usedThisMonth: number }> = [];
  if (targetDomain) {
    for (const index of indexes) {
      const result = await fetchPage(index);
      fetched.push(result);
      if (
        result.page.organic.length === 0 ||
        result.page.organic.some((item) =>
          linkMatchesDomain(item.link, targetDomain),
        )
      ) {
        break;
      }
    }
  } else {
    fetched = await Promise.all(indexes.map(fetchPage));
  }

  const organic: Array<{
    position: number;
    title: string | null;
    url: string | null;
    domain: string | null;
    description: string | null;
  }> = [];
  const features = new Set<string>();
  for (const { page } of fetched) {
    for (const feature of serpFeatures(page)) features.add(feature);
    if (page.organic.length === 0) break;
    const before = resume.organicCount + organic.length;
    organic.push(
      ...page.organic.map((item, offset) => ({
        position: before + offset + 1,
        title: item.title ?? null,
        url: item.link ?? null,
        domain: domainOf(item.link),
        description: item.description ?? null,
      })),
    );
  }

  const firstPage = resume.pages === 0 ? fetched[0]?.page : undefined;
  return {
    organic,
    features: [...features],
    firstPage: firstPage ?? { organic: [], snack_pack: [] },
    usedThisMonth: Math.max(
      0,
      ...fetched.map((result) => result.usedThisMonth),
    ),
  };
}

/**
 * The live Google SERP to `depth` results, one request per page of about 10.
 * With `targetDomain`, paging stops at the page where that domain ranks, so a
 * page-1 ranking costs one request. Positions count organic results only, in
 * Google's order across pages. The local pack and the other sections (People
 * Also Ask, ads, AI Overview...) come from the first page, which is also saved
 * to the organization's SERP observation store. With `resume`, only the pages
 * after those already fetched are requested, so the local pack and the other
 * sections are empty.
 */
export async function fetchBrightDataSerp(
  config: BrightDataSerp,
  input: SerpRequest,
  resume?: ResumeAfter,
) {
  const { organic, features, firstPage, usedThisMonth } =
    await fetchOrganicPages(config, input, resume);
  return {
    organic,
    localPack: firstPage.snack_pack.map((item, index) => ({
      position: index + 1,
      title: item.name ?? null,
      url: item.link ?? null,
      rating: item.rating ?? null,
      reviewsCount: item.reviews_cnt ?? null,
    })),
    ...readSerpSections(firstPage),
    features,
    usedThisMonth,
  };
}

/**
 * The AI Overview section of the Google results page for one AI visibility
 * prompt, as Bright Data parsed it: undefined when the page has none. One
 * desktop request from the budget, as DataForSEO checks AI Overviews on
 * desktop, and the page is saved to the SERP observation store like every
 * first page. Bright Data does not wait for an AI Overview that Google loads
 * after the page (see fetchSerpPage), so some are missed.
 */
export async function fetchBrightDataAiOverview(
  config: BrightDataSerp,
  input: {
    prompt: string;
    locationCode: number;
    languageCode: string;
    organizationId: string;
  },
): Promise<unknown> {
  const request: SerpRequest = {
    keyword: input.prompt,
    market: input,
    device: "desktop",
    depth: RESULTS_PER_PAGE,
    observation: {
      organizationId: input.organizationId,
      origin: "ai_visibility",
    },
  };
  const { page } = await fetchSerpPage(config, { ...request, start: 0 });
  await recordFirstPage(request, page);
  return page.ai_overview;
}

/**
 * One rank check, in the shape DataForSEO rank checks produce. With
 * `reuseFirstPage`, a first page of the same search saved for the
 * organization in the last few days stands in for page 1: a domain on it
 * costs no request, and a deeper check pays only for the pages after it.
 */
export async function checkRankOnBrightData(
  config: BrightDataSerp,
  input: {
    keyword: string;
    keywordId: string;
    locationCode: number;
    languageCode: string;
    locationName?: string;
    device: Device;
    targetDomain: string;
    depth: number;
    organizationId: string;
    reuseFirstPage: boolean;
  },
): Promise<RankCheckResult> {
  const request: SerpRequest = {
    keyword: input.keyword,
    market: input,
    device: input.device,
    depth: input.depth,
    targetDomain: input.targetDomain,
    observation: { organizationId: input.organizationId, origin: "rank_check" },
  };
  const stored = input.reuseFirstPage
    ? await SerpObservationRepository.findLatest({
        ...input,
        since: new Date(
          Date.now() - FIRST_PAGE_REUSE_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
    : null;

  let organic: Array<{ position: number; url: string | null }>;
  let features: string[];
  if (stored) {
    const onFirstPage = stored.organic.some((item) =>
      linkMatchesDomain(item.url, input.targetDomain),
    );
    const later =
      !onFirstPage &&
      stored.organic.length > 0 &&
      input.depth > RESULTS_PER_PAGE
        ? await fetchOrganicPages(config, request, {
            pages: 1,
            organicCount: stored.organic.length,
          })
        : null;
    organic = [...stored.organic, ...(later?.organic ?? [])];
    features = orderedFeatures([
      ...stored.features,
      ...(later?.features ?? []),
    ]);
  } else {
    ({ organic, features } = await fetchOrganicPages(config, request));
  }

  const match = organic.find((item) =>
    linkMatchesDomain(item.url, input.targetDomain),
  );
  return {
    keywordId: input.keywordId,
    keyword: input.keyword,
    position: match?.position ?? null,
    url: match?.url ?? null,
    serpFeatures: features,
  };
}
