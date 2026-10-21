import { mapValues } from "remeda";
import { z } from "zod";
import { AppError } from "@/server/lib/errors";

// Chrome UX Report (CrUX) API: real-user field data for any public origin or
// URL. Free, with a fixed quota of 150 queries per minute per Google Cloud
// project (shared by both endpoints) that cannot be paid up, so no request can
// be billed. The URL is a fixed Google host, so no SSRF screening applies.
const CRUX_URL = "https://chromeuxreport.googleapis.com/v1/records";
const REQUEST_TIMEOUT_MS = 15_000;

// Good and poor boundaries from PageSpeed Insights: good is [0, good], needs
// improvement is (good, poor], poor is above. CrUX histograms use the same
// three bins in this order.
export const CRUX_METRICS = {
  lcp: {
    name: "largest_contentful_paint",
    label: "LCP",
    unit: "ms",
    good: 2500,
    poor: 4000,
  },
  inp: {
    name: "interaction_to_next_paint",
    label: "INP",
    unit: "ms",
    good: 200,
    poor: 500,
  },
  cls: {
    name: "cumulative_layout_shift",
    label: "CLS",
    unit: "",
    good: 0.1,
    poor: 0.25,
  },
  fcp: {
    name: "first_contentful_paint",
    label: "FCP",
    unit: "ms",
    good: 1800,
    poor: 3000,
  },
  ttfb: {
    name: "experimental_time_to_first_byte",
    label: "TTFB",
    unit: "ms",
    good: 800,
    poor: 1800,
  },
} as const;

type CruxQuery = {
  apiKey: string;
  target: { origin: string } | { url: string };
  /** Omitted: every device combined (tablet included). */
  formFactor?: "PHONE" | "DESKTOP";
};

// CLS comes as a decimal string; History marks missing densities "NaN" and
// missing p75s null.
const numeric = z
  .union([z.number(), z.string(), z.null()])
  .transform((value) => {
    const number = value == null ? NaN : Number(value);
    return Number.isFinite(number) ? number : null;
  });

const dateSchema = z
  .object({ year: z.number(), month: z.number(), day: z.number() })
  .transform(
    ({ year, month, day }) =>
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  );

const periodSchema = z.object({ firstDate: dateSchema, lastDate: dateSchema });

const recordResponseSchema = z.object({
  record: z.object({
    key: z.object({
      origin: z.string().optional(),
      url: z.string().optional(),
    }),
    metrics: z
      .record(
        z.string(),
        z.object({
          histogram: z.array(z.object({ density: numeric })).optional(),
          percentiles: z.object({ p75: numeric }).optional(),
        }),
      )
      .default({}),
    collectionPeriod: periodSchema,
  }),
  urlNormalizationDetails: z
    .object({ normalizedUrl: z.string().optional() })
    .optional(),
});

const historyResponseSchema = z.object({
  record: z.object({
    metrics: z
      .record(
        z.string(),
        z.object({
          percentilesTimeseries: z
            .object({ p75s: z.array(numeric) })
            .optional(),
        }),
      )
      .default({}),
    collectionPeriods: z.array(periodSchema),
  }),
});

const errorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

function cruxHttpError(
  status: number,
  message: string,
  reasons: string[],
): AppError {
  // An unknown key comes back as 400 API_KEY_INVALID, not 401.
  if (status === 401 || status === 403 || reasons.includes("API_KEY_INVALID")) {
    return new AppError(
      "AUTH_CONFIG_MISSING",
      `Chrome UX Report refused GOOGLE_PAGESPEED_API_KEY: ${message} Enable the Chrome UX Report API in the key's Google Cloud project and allow it in the key's API restrictions.`,
    );
  }
  if (status === 400) {
    return new AppError(
      "VALIDATION_ERROR",
      `Chrome UX Report rejected the request: ${message}`,
    );
  }
  if (status === 429) {
    return new AppError(
      "RATE_LIMITED",
      "Chrome UX Report quota exceeded (150 queries per minute per Google Cloud project, free and not raisable). Wait a minute, then retry with fewer targets.",
    );
  }
  return new AppError("UPSTREAM_UNAVAILABLE", `Chrome UX Report: ${message}`);
}

/** POSTs one CrUX query; null when CrUX has no data (404). */
async function postCrux(
  method: "queryRecord" | "queryHistoryRecord",
  query: CruxQuery,
  extra: Record<string, unknown>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${CRUX_URL}:${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A header, never ?key=, so the key stays out of logged URLs.
        "X-Goog-Api-Key": query.apiKey,
      },
      body: JSON.stringify({
        ...query.target,
        formFactor: query.formFactor,
        metrics: Object.values(CRUX_METRICS).map((metric) => metric.name),
        ...extra,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("[crux] request failed:", error);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      error instanceof Error && error.name === "TimeoutError"
        ? `Chrome UX Report did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
        : "Chrome UX Report could not be reached.",
    );
  }

  // "chrome ux report data not found": too few Chrome visits, or not the
  // origin visitors actually land on.
  if (response.status === 404) return null;

  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(json);
    const message = (
      parsed.success ? parsed.data.error.message : `HTTP ${response.status}`
    ).replaceAll(query.apiKey, "<api key>");
    const reasons = parsed.success
      ? (parsed.data.error.details ?? []).flatMap(({ reason }) =>
          reason ? [reason] : [],
        )
      : [];
    console.warn(`[crux] HTTP ${response.status}: ${message}`);
    throw cruxHttpError(response.status, message, reasons);
  }
  return json;
}

function invalidResponse(error: z.ZodError): AppError {
  console.warn("[crux] unexpected response:", error.message);
  return new AppError(
    "UPSTREAM_UNAVAILABLE",
    "Chrome UX Report returned an unexpected response.",
  );
}

function rate(p75: number, good: number, poor: number) {
  if (p75 <= good) return "good";
  return p75 <= poor ? "needs_improvement" : "poor";
}

/** The 28-day record ending about two days ago; null when CrUX has no data. */
export async function fetchCruxRecord(query: CruxQuery) {
  const json = await postCrux("queryRecord", query, {});
  if (json == null) return null;
  const parsed = recordResponseSchema.safeParse(json);
  if (!parsed.success) throw invalidResponse(parsed.error);
  const { record, urlNormalizationDetails } = parsed.data;

  const metrics = mapValues(CRUX_METRICS, ({ name, good, poor }) => {
    const metric = record.metrics[name];
    const p75 = metric?.percentiles?.p75 ?? null;
    if (p75 == null) return null;
    const [goodBin, needsImprovementBin, poorBin] = metric?.histogram ?? [];
    return {
      p75,
      rating: rate(p75, good, poor),
      // Share of page loads in each bin, 0 to 1.
      good: goodBin?.density ?? null,
      needsImprovement: needsImprovementBin?.density ?? null,
      poor: poorBin?.density ?? null,
    };
  });

  // PageSpeed Insights' rule: LCP and CLS must have data; INP counts when it
  // has data.
  const { lcp, cls, inp } = metrics;
  const coreWebVitals: "passed" | "failed" | "not_assessed" =
    lcp == null || cls == null
      ? "not_assessed"
      : [lcp, cls, inp].every(
            (metric) => metric == null || metric.rating === "good",
          )
        ? "passed"
        : "failed";

  return {
    key: record.key.origin ?? record.key.url ?? null,
    normalizedUrl: urlNormalizationDetails?.normalizedUrl ?? null,
    collectionPeriod: record.collectionPeriod,
    coreWebVitals,
    metrics,
  };
}

/**
 * Weekly p75 values (oldest first), each over the 28 days ending `windowEnd`.
 * A null value means CrUX had too little data that week.
 */
export async function fetchCruxHistory(query: CruxQuery & { weeks: number }) {
  const json = await postCrux("queryHistoryRecord", query, {
    collectionPeriodCount: query.weeks,
  });
  if (json == null) return null;
  const parsed = historyResponseSchema.safeParse(json);
  if (!parsed.success) throw invalidResponse(parsed.error);
  const { metrics, collectionPeriods } = parsed.data.record;

  return collectionPeriods.map((period, index) => ({
    windowEnd: period.lastDate,
    ...mapValues(
      CRUX_METRICS,
      ({ name }) => metrics[name]?.percentilesTimeseries?.p75s[index] ?? null,
    ),
  }));
}
