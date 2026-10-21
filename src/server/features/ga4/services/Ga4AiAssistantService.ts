import { waitUntil } from "cloudflare:workers";
import { sortBy } from "remeda";
import { z } from "zod";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import {
  createGa4DataClient,
  type Ga4RunReportRequest,
} from "@/server/lib/ga4Client";
import { Ga4ReportError } from "@/server/lib/ga4Errors";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import { normalizeGa4Response } from "./Ga4ReportNormalization";
import { mapGa4ReportError, resolveGa4DateRange } from "./Ga4ReportingService";

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const TOP_SOURCES = 10;

/**
 * Sessions that GA4 puts in its "AI Assistant" channel, or whose source names
 * an AI assistant, for properties whose channel group predates that channel.
 */
const AI_ASSISTANT_FILTER = {
  orGroup: {
    expressions: [
      {
        filter: {
          fieldName: "sessionDefaultChannelGroup",
          stringFilter: {
            matchType: "EXACT",
            value: "AI Assistant",
            caseSensitive: false,
          },
        },
      },
      {
        filter: {
          fieldName: "sessionSource",
          stringFilter: {
            matchType: "PARTIAL_REGEXP",
            value: "chatgpt|openai|perplexity|claude|gemini|copilot",
            caseSensitive: false,
          },
        },
      },
    ],
  },
};

const aiAssistantVisitsSchema = z.object({
  propertyDisplayName: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  sessions: z.number(),
  keyEvents: z.number(),
  sources: z.array(
    z.object({
      source: z.string(),
      sessions: z.number(),
      keyEvents: z.number(),
    }),
  ),
  hasLimitedData: z.boolean(),
});

type Ga4AiAssistantVisits = z.infer<typeof aiAssistantVisitsSchema>;

/**
 * Visits from AI assistants to the project's Google Analytics property over
 * the last 28 complete days, by session source. Cached for a day.
 */
async function getAiAssistantVisits(
  projectId: string,
  opts: { now?: Date } = {},
): Promise<Ga4AiAssistantVisits> {
  const connection = await Ga4ConnectionRepository.getByProjectId(projectId);
  if (!connection) {
    throw new Ga4ReportError(
      "ga4_not_connected",
      "Google Analytics is not connected for this project.",
    );
  }
  const range = resolveGa4DateRange(
    {},
    connection.propertyTimeZone,
    opts.now,
  ).resolvedDateRange;
  const cacheKey = await buildCacheKey("ga4:ai-assistant-visits", {
    projectId,
    propertyId: connection.propertyId,
    ...range,
  });
  const cached = aiAssistantVisitsSchema.safeParse(await getCached(cacheKey));
  if (cached.success) return cached.data;

  const request: Ga4RunReportRequest = {
    dateRanges: [range],
    dimensions: [{ name: "sessionSource" }],
    metrics: [{ name: "sessions" }, { name: "keyEvents" }],
    dimensionFilter: AI_ASSISTANT_FILTER,
    offset: "0",
    limit: "100",
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    keepEmptyRows: false,
    returnPropertyQuota: true,
  };
  const client = createGa4DataClient({
    userId: connection.connectedByUserId,
    ga4AccountId: connection.ga4AccountId,
    propertyId: connection.propertyId,
  });
  let report;
  try {
    report = normalizeGa4Response(await client.runReport(request), request);
  } catch (error) {
    mapGa4ReportError(error);
  }
  const sources = report.rows.map((row) => ({
    source: String(row.sessionSource ?? ""),
    sessions: Number(row.sessions ?? 0),
    keyEvents: Number(row.keyEvents ?? 0),
  }));
  const visits: Ga4AiAssistantVisits = {
    propertyDisplayName: connection.propertyDisplayName,
    ...range,
    sessions: sources.reduce((sum, row) => sum + row.sessions, 0),
    keyEvents: sources.reduce((sum, row) => sum + row.keyEvents, 0),
    sources: sortBy(sources, [(row) => row.sessions, "desc"]).slice(
      0,
      TOP_SOURCES,
    ),
    hasLimitedData: report.reportMetadata.hasLimitedData,
  };
  waitUntil(
    setCached(cacheKey, visits, CACHE_TTL_SECONDS).catch((error) => {
      console.error("ga4.ai-assistant-visits.cache-write failed:", error);
    }),
  );
  return visits;
}

export const Ga4AiAssistantService = { getAiAssistantVisits };
