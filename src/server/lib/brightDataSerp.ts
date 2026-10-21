import { z } from "zod";
import { GooglePlacesUsageRepository } from "@/server/features/google-places/repositories/GooglePlacesUsageRepository";
import type { RankCheckResult } from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";
import {
  getGoogleFallbackKey,
  getOptionalEnvValue,
} from "@/server/lib/runtime-env";
import { googleSerpUrl } from "@/shared/google-serp-url";
import { jsonCodec } from "@/shared/json";
import { getIsoCountryCode } from "@/shared/keyword-locations";

// Bright Data's SERP API: the live Google SERP behind rank tracking,
// get_serp_results and find_serp_competitors on self-hosted installs without
// DataForSEO. The URL is a fixed provider host, so no SSRF screening applies.
const REQUEST_URL = "https://api.brightdata.com/request";
// Bright Data takes 20-50 s per Google page.
const REQUEST_TIMEOUT_MS = 90_000;
/** Google shows about 10 organic results per page; each page is one request. */
const RESULTS_PER_PAGE = 10;
const MAX_PAGES = 10;

// Hard-coded below the free tier's 5,000 requests a month so a self-hosted
// install is never charged. There is deliberately no setting to raise it.
const MONTHLY_BUDGET = 4500;

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
});

const serpPageCodec = jsonCodec(serpPageSchema);

type SerpPage = z.infer<typeof serpPageSchema>;

type SerpMarket = {
  locationCode: number;
  languageCode: string;
  locationName?: string | null;
};

type Device = "desktop" | "mobile";

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

export function brightDataBudgetLine(usedThisMonth: number): string {
  return `Bright Data budget: ${usedThisMonth} of ${MONTHLY_BUDGET} SERP requests used this month (resets on the 1st, UTC).`;
}

export const BRIGHTDATA_RANK_CHECK_NOTE = `Rank checks on this server run on Bright Data's live Google SERP: each keyword and device sends one request per 10 results of depth, stopping at the page where the tracked domain appears, from this server's monthly budget of ${MONTHLY_BUDGET} requests.`;

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

function serpFeatures(page: SerpPage): string[] {
  return Object.entries(SERP_FEATURES)
    .filter(([section]) => {
      const value: unknown = page[section];
      if (Array.isArray(value)) return value.length > 0;
      return typeof value === "object" && value !== null;
    })
    .map(([, feature]) => feature);
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
      "RATE_LIMITED",
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

/**
 * The live Google SERP to `depth` results, one request per page of about 10.
 * With `targetDomain`, paging stops at the page where that domain ranks, so a
 * page-1 ranking costs one request. Positions count organic results only, in
 * Google's order across pages. The local pack comes from the first page.
 */
export async function fetchBrightDataSerp(
  config: BrightDataSerp,
  input: {
    keyword: string;
    market: SerpMarket;
    device: Device;
    depth: number;
    targetDomain?: string;
  },
) {
  const pages = Math.min(
    MAX_PAGES,
    Math.max(1, Math.ceil(input.depth / RESULTS_PER_PAGE)),
  );
  const organic: Array<{
    position: number;
    title: string | null;
    url: string | null;
    domain: string | null;
    description: string | null;
  }> = [];
  const features = new Set<string>();
  let localPack: SerpPage["snack_pack"] = [];
  let usedThisMonth = 0;

  for (let index = 0; index < pages; index++) {
    const result = await fetchSerpPage(config, {
      ...input,
      start: index * RESULTS_PER_PAGE,
    });
    usedThisMonth = result.usedThisMonth;
    for (const feature of serpFeatures(result.page)) features.add(feature);
    if (index === 0) localPack = result.page.snack_pack;
    const before = organic.length;
    organic.push(
      ...result.page.organic.map((item, offset) => ({
        position: before + offset + 1,
        title: item.title ?? null,
        url: item.link ?? null,
        domain: hostOf(item.link)?.replace(/^www\./, "") ?? null,
        description: item.description ?? null,
      })),
    );
    const { targetDomain } = input;
    if (
      result.page.organic.length === 0 ||
      (targetDomain &&
        result.page.organic.some((item) =>
          linkMatchesDomain(item.link, targetDomain),
        ))
    ) {
      break;
    }
  }

  return {
    organic,
    localPack: localPack.map((item, index) => ({
      position: index + 1,
      title: item.name ?? null,
      url: item.link ?? null,
      rating: item.rating ?? null,
      reviewsCount: item.reviews_cnt ?? null,
    })),
    features: [...features],
    usedThisMonth,
  };
}

/** One rank check, in the shape DataForSEO rank checks produce. */
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
  },
): Promise<RankCheckResult> {
  const serp = await fetchBrightDataSerp(config, {
    keyword: input.keyword,
    market: input,
    device: input.device,
    depth: input.depth,
    targetDomain: input.targetDomain,
  });
  const match = serp.organic.find((item) =>
    linkMatchesDomain(item.url, input.targetDomain),
  );
  return {
    keywordId: input.keywordId,
    keyword: input.keyword,
    position: match?.position ?? null,
    url: match?.url ?? null,
    serpFeatures: serp.features,
  };
}
