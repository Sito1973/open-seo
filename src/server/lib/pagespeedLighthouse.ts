import { z } from "zod";
import {
  buildStoredLighthousePayload,
  type RawLighthouseAudit,
  type RawLighthouseCategory,
  type StoredLighthousePayload,
  summarizeZodIssues,
  withLighthouseParseLock,
} from "@/server/lib/lighthouseStoredPayload";

// PageSpeed Insights runs the same Lighthouse report DataForSEO returns, free
// with a Google API key. Self-hosted installs without DataForSEO use it.
const PAGESPEED_URL =
  "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed";
const PAGESPEED_CATEGORIES = [
  "PERFORMANCE",
  "ACCESSIBILITY",
  "BEST_PRACTICES",
  "SEO",
] as const;
// Partial response: only what the stored payload reads. Screenshots, the
// full-page screenshot and loading-experience field data are left out.
const PAGESPEED_FIELDS =
  "analysisUTCTimestamp,lighthouseResult(requestedUrl,finalUrl,lighthouseVersion,runtimeError,categories,audits)";
// A live Lighthouse run on a slow page can take over a minute.
const REQUEST_TIMEOUT_MS = 120_000;

const pagespeedResponseSchema = z.object({
  analysisUTCTimestamp: z.string().optional(),
  lighthouseResult: z.object({
    requestedUrl: z.string().optional(),
    finalUrl: z.string().optional(),
    lighthouseVersion: z.string().optional(),
    runtimeError: z
      .object({ code: z.string().optional(), message: z.string().optional() })
      .optional(),
    // Only the key maps are copied, so the multi-MB category and audit bodies
    // stay as the response's own objects (see dataforseoLighthousePayload.ts).
    categories: z
      .record(z.string(), z.custom<RawLighthouseCategory>())
      .optional(),
    audits: z.record(z.string(), z.custom<RawLighthouseAudit>()).optional(),
  }),
});

const pagespeedErrorSchema = z.object({
  error: z.object({ message: z.string() }),
});

export async function fetchPagespeedLighthouse(input: {
  url: string;
  strategy: "mobile" | "desktop";
  apiKey: string;
}): Promise<StoredLighthousePayload> {
  const requestUrl = new URL(PAGESPEED_URL);
  requestUrl.searchParams.set("url", input.url);
  requestUrl.searchParams.set("strategy", input.strategy.toUpperCase());
  for (const category of PAGESPEED_CATEGORIES) {
    requestUrl.searchParams.append("category", category);
  }
  requestUrl.searchParams.set("fields", PAGESPEED_FIELDS);

  // The timeout is cleared once headers arrive, so a body read queued behind
  // the parse lock is never aborted.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    // The key goes in a header, never the query string, so it stays out of
    // URLs that proxies and error messages might log.
    response = await fetch(requestUrl, {
      headers: { "X-Goog-Api-Key": input.apiKey },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      controller.signal.aborted
        ? `PageSpeed Insights: no response within ${REQUEST_TIMEOUT_MS / 1000} seconds`
        : `PageSpeed Insights: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const parsed = pagespeedErrorSchema.safeParse(body);
    const message = parsed.success
      ? parsed.data.error.message
      : `HTTP ${response.status}`;
    // The message is stored on the audit row; never let it carry the key.
    throw new Error(
      `PageSpeed Insights: ${message.replaceAll(input.apiKey, "<api key>")}`,
    );
  }

  return withLighthouseParseLock(async () => {
    const parsed = pagespeedResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(
        `PageSpeed Insights returned an invalid response: ${summarizeZodIssues(parsed.error)}`,
      );
    }

    const report = parsed.data.lighthouseResult;
    const runtimeError = report.runtimeError;
    if (runtimeError?.code && runtimeError.code !== "NO_ERROR") {
      throw new Error(
        `PageSpeed Insights: Lighthouse returned error: ${runtimeError.code} ${runtimeError.message ?? ""}`.trim(),
      );
    }

    return buildStoredLighthousePayload({
      report: {
        requestedUrl: report.requestedUrl,
        finalUrl: report.finalUrl ?? report.requestedUrl,
        lighthouseVersion: report.lighthouseVersion,
        categories: report.categories,
        audits: report.audits,
      },
      request: { url: input.url, strategy: input.strategy },
      source: "pagespeed-insights",
      taskId: null,
      cost: null,
      fetchedAt: parsed.data.analysisUTCTimestamp ?? new Date().toISOString(),
      providerLabel: "PageSpeed Insights",
    });
  });
}
