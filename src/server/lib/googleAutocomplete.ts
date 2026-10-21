import { unique } from "remeda";
import { z } from "zod";
import { GooglePlacesUsageRepository } from "@/server/features/google-places/repositories/GooglePlacesUsageRepository";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import {
  getDataforseoKey,
  isHostedServerAuthMode,
} from "@/server/lib/runtime-env";
import { getIsoCountryCode } from "@/shared/keyword-locations";

// Google's search suggestions, from the endpoint behind Firefox's search box:
// the phrase-match keyword ideas of keyword research on self-hosted installs
// where the Keyword Planner stands in for DataForSEO. It is not an official
// API, and Google may block a server that calls it too often, so OpenSEO
// calls it gently: about 40 lookups per new seed, one a second, each answer
// cached 30 days, within a monthly budget, and a refusal pauses every lookup
// for a day. The host is fixed, so no SSRF screening applies.
const REQUEST_URL = "https://suggestqueries.google.com/complete/search";
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_REQUEST_INTERVAL_MS = 1_000;
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
// About 50 new seeds a month. There is deliberately no setting to raise it.
const MONTHLY_BUDGET = 2_000;
const PAUSE_SECONDS = 24 * 60 * 60;
const PAUSE_CACHE_KEY = "google-autocomplete:paused";

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
// Spanish searches put intent around the product: "mejor ...", "donde ...",
// "... cerca", "... a domicilio", "... en <ciudad>". Unaccented, as people
// type them.
const SPANISH_PREFIXES = ["mejor", "mejores", "donde", "como", "que", "cuanto"];
const SPANISH_SUFFIXES = [
  "en",
  "de",
  "para",
  "con",
  "cerca",
  "precio",
  "domicilio",
];

// client=firefox answers ["query", ["suggestion", ...], ...].
const responseSchema = z.tuple([z.string(), z.array(z.string())], z.unknown());
const cachedSchema = z.object({ suggestions: z.array(z.string()) });
const pauseSchema = z.object({ until: z.string() });

type Lookup = { suggestions: string[] } | { problem: "blocked" | "failed" };

/** The seed itself, Spanish modifiers around it, then the seed and a-z. */
function lookupQueries(seed: string, languageCode: string): string[] {
  const modifiers =
    languageCode === "es"
      ? [
          ...SPANISH_PREFIXES.map((word) => `${word} ${seed}`),
          ...SPANISH_SUFFIXES.map((word) => `${seed} ${word}`),
        ]
      : [];
  return [seed, ...modifiers, ...LETTERS.map((letter) => `${seed} ${letter}`)];
}

// Spaces lookups at least a second apart in this process, so parallel seeds
// queue instead of bursting.
let nextRequestAt = 0;

async function waitForRequestSlot() {
  const now = Date.now();
  const at = Math.max(now, nextRequestAt);
  nextRequestAt = at + MIN_REQUEST_INTERVAL_MS;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

async function lookup(url: string): Promise<Lookup> {
  await waitForRequestSlot();
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("[google-autocomplete] request failed:", error);
    return { problem: "failed" };
  }
  // A blocked server gets 429 or 403, or Google's /sorry/ captcha page.
  if (
    response.status === 429 ||
    response.status === 403 ||
    response.url.includes("/sorry/")
  ) {
    console.warn(`[google-autocomplete] refused: HTTP ${response.status}`);
    return { problem: "blocked" };
  }
  const parsed = responseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!response.ok || !parsed.success) {
    console.warn(`[google-autocomplete] unexpected answer: ${response.status}`);
    // A page that is not the JSON answer is a consent or captcha page.
    return { problem: response.ok ? "blocked" : "failed" };
  }
  return { suggestions: parsed.data[1] };
}

function utcMinute(iso: string) {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Google autocomplete suggestions for a seed in one market, trimmed,
 * lowercased and unique. Each lookup's answer is cached 30 days, so a repeated
 * seed sends nothing. When lookups stop early (paused after Google refused
 * this server, past the monthly budget, or Google did not answer), the
 * suggestions gathered so far come back and `unavailable` says why. Never on
 * hosted or next to DataForSEO for other features, as getGoogleFallbackKey
 * rules for every Google stand-in.
 */
export async function fetchGoogleAutocomplete(input: {
  seed: string;
  locationCode: number;
  languageCode: string;
}): Promise<{ suggestions: string[]; unavailable: string | null }> {
  if ((await getDataforseoKey("other")) || (await isHostedServerAuthMode())) {
    return {
      suggestions: [],
      unavailable:
        "Google autocomplete runs only on self-hosted installs without DataForSEO.",
    };
  }
  const gl = getIsoCountryCode(input.locationCode);
  // Latin American Spanish outside Spain, as Google serves it there.
  const hl =
    input.languageCode === "es" && gl !== "es" ? "es-419" : input.languageCode;
  const found: string[] = [];
  const result = (unavailable: string | null) => ({
    suggestions: unique(
      found.map((text) => text.trim().toLowerCase()).filter(Boolean),
    ),
    unavailable,
  });

  const seed = input.seed.trim().toLowerCase();
  for (const query of lookupQueries(seed, input.languageCode)) {
    const cacheKey = await buildCacheKey("google-autocomplete", {
      query,
      hl,
      gl,
    });
    const cached = cachedSchema.safeParse(await getCached(cacheKey));
    if (cached.success) {
      found.push(...cached.data.suggestions);
      continue;
    }
    const paused = pauseSchema.safeParse(await getCached(PAUSE_CACHE_KEY));
    if (paused.success) {
      return result(
        `Google autocomplete is paused until ${utcMinute(paused.data.until)} because Google refused this server's lookups.`,
      );
    }
    const month = new Date().toISOString().slice(0, 7);
    const used = await GooglePlacesUsageRepository.reserveCalls({
      month,
      sku: "google_autocomplete",
      count: 1,
      limit: MONTHLY_BUDGET,
    });
    if (used == null) {
      return result(
        `This server's monthly Google autocomplete budget (${MONTHLY_BUDGET} lookups in ${month}, UTC) is used up. It resets on the 1st.`,
      );
    }
    const params = new URLSearchParams({
      client: "firefox",
      hl,
      gl,
      ie: "UTF-8",
      oe: "UTF-8",
      q: query,
    });
    const answer = await lookup(`${REQUEST_URL}?${params}`);
    if ("problem" in answer) {
      if (answer.problem === "failed") {
        return result(
          "Google autocomplete did not answer, so its remaining lookups were skipped.",
        );
      }
      const until = new Date(Date.now() + PAUSE_SECONDS * 1000).toISOString();
      await setCached(PAUSE_CACHE_KEY, { until }, PAUSE_SECONDS);
      return result(
        `Google refused this server's autocomplete lookups, so they are paused until ${utcMinute(until)}.`,
      );
    }
    await setCached(
      cacheKey,
      { suggestions: answer.suggestions },
      CACHE_TTL_SECONDS,
    );
    found.push(...answer.suggestions);
  }
  return result(null);
}
