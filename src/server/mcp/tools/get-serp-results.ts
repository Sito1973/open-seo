import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import {
  createDataforseoClient,
  SERP_ANALYSIS_DEPTH,
} from "@/server/lib/dataforseo";
import {
  brightDataBudgetLine,
  brightDataSourceNote,
  fetchBrightDataSerp,
  getBrightDataSerp,
  type BrightDataSerp,
} from "@/server/lib/brightDataSerp";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { resolveMarket } from "@/shared/keyword-locations";
import { assertLocalResearchLocation } from "@/server/features/keywords/services/research/local-volume";
import { toolErrorMessage } from "@/server/mcp/tool-error-message";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import {
  AI_OVERVIEW_NOT_DETECTED_NOTE,
  formatSerpSectionRows,
  hasAiOverview,
  serpSectionRowSchema,
  serpSectionRows,
} from "@/server/mcp/tools/serp-sections";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";

// A repeat within this window is answered from the saved rows, uncharged, so a
// caller that lost a response can call again instead of paying twice.
const SERP_RESULTS_CACHE_TTL_SECONDS = 12 * 60 * 60;

const serpItemSchema = z
  .object({
    type: z.string().nullable().optional(),
    rank: z.number().nullable(),
    title: z.string().nullable(),
    url: z.string().nullable(),
    domain: z.string().nullable(),
    description: z.string().nullable(),
  })
  .passthrough();

type SerpItem = z.infer<typeof serpItemSchema>;

const SERP_ITEM_COLUMNS: McpTableColumn<SerpItem>[] = [
  { header: "rank", value: (item) => item.rank },
  { header: "domain", value: (item) => item.domain },
  { header: "title", value: (item) => item.title },
  { header: "url", value: (item) => item.url },
];

const localPackItemSchema = z.object({
  rank: z.number(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  rating: z.number().nullable(),
  reviews_count: z.number().nullable(),
});

type LocalPackItem = z.infer<typeof localPackItemSchema>;

const brightDataCacheSchema = z.object({
  organic: z.array(serpItemSchema),
  localPack: z.array(localPackItemSchema),
  sections: z.array(serpSectionRowSchema),
});

const LOCAL_PACK_COLUMNS: McpTableColumn<LocalPackItem>[] = [
  { header: "rank", value: (item) => item.rank },
  { header: "name", value: (item) => item.title },
  { header: "rating", value: (item) => item.rating },
  { header: "reviews", value: (item) => item.reviews_count },
  { header: "url", value: (item) => item.url },
];

const querySchema = z.object({
  keyword: z.string().min(1).describe("Search query to fetch the SERP for."),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
  locationName: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional city, county, or region inside the query's country, for a local SERP. Call search_serp_locations first and pass its locationName verbatim; if it is unavailable, pass Google's canonical City,Region,Country name (e.g. Pereira,Risaralda,Colombia). Same price as a national SERP.",
    ),
});

const inputSchema = {
  projectId: projectIdSchema,
  queries: z
    .array(querySchema)
    .min(1)
    .max(10)
    .describe(
      "1-10 queries. Bulk-friendly — prefer this over multiple single-query calls.",
    ),
  depth: z
    .number()
    .int()
    .min(10)
    .max(100)
    .multipleOf(10)
    .optional()
    .describe(
      "How many SERP rows to crawl per keyword — a multiple of 10 from 10 to 100, default 20. Google has no offset, so a deeper crawl re-fetches the top too: each additional 10 adds ~2.5 credits per keyword. Only raise it when you need ranks past the top 20.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getSerpResultsTool = {
  name: "get_serp_results",
  config: {
    title: "Get Google SERP results",
    description:
      "Fetch live Google organic search results for 1-10 keywords. Use this to inspect who ranks for a query, verify competitors, compare SERPs across keywords, or gather source URLs before content planning. Returns the top `depth` result rows per keyword (default 20). Charges credits per keyword: ~5 each at the default depth 20, and each additional 10 of depth adds ~2.5. A keyword fetched in this project in the last 12 hours with the same market and depth returns those rows again at no charge once the original call has finished, so if a response is lost, wait a minute and repeat the same call. Per-keyword errors don't fail the batch.",
    inputSchema,
    outputSchema: z.looseObject({
      results: z.array(
        z.union([
          z
            .object({
              keyword: z.string(),
              ok: z.literal(true),
              items: z.array(serpItemSchema),
            })
            .passthrough(),
          z
            .object({
              keyword: z.string(),
              ok: z.literal(false),
              error: z.string(),
            })
            .passthrough(),
        ]),
      ),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const brightData = await getBrightDataSerp();
    if (brightData) return getBrightDataSerpResults(brightData, args, context);
    const client = createDataforseoClient(context.billing);
    const depth = args.depth ?? SERP_ANALYSIS_DEPTH;
    const results = await Promise.all(
      args.queries.map(async (q) => {
        try {
          const market = resolveMarket(q, context.project);
          if (q.locationName) {
            await assertLocalResearchLocation(
              market.locationCode,
              q.locationName,
            );
          }
          const cacheKey = await buildCacheKey("mcp:serp-results", {
            organizationId: context.billing.organizationId,
            projectId: args.projectId,
            keyword: q.keyword,
            ...market,
            locationName: q.locationName,
            depth,
          });
          const cached = z
            .array(serpItemSchema)
            .safeParse(await getCached(cacheKey));
          if (cached.success) {
            return {
              keyword: q.keyword,
              ok: true as const,
              items: cached.data,
            };
          }

          const items = await client.serp.live({
            keyword: q.keyword,
            ...market,
            locationName: q.locationName,
            depth,
          });
          // Trim noise — return only essentials per item.
          const trimmed = items.slice(0, depth).map((item) => ({
            type: item.type,
            rank: item.rank_absolute ?? item.rank_group ?? null,
            title: item.title ?? null,
            url: item.url ?? null,
            domain: item.domain ?? null,
            description: item.description ?? null,
          }));
          // DataForSEO reports "no results" transiently; don't pin that for
          // the whole window. waitUntil, not void: workerd cancels
          // unregistered pending I/O once the response is sent.
          if (trimmed.length > 0) {
            waitUntil(
              setCached(
                cacheKey,
                trimmed,
                SERP_RESULTS_CACHE_TTL_SECONDS,
              ).catch((error) => {
                console.error("mcp.serp-results.cache-write failed:", error);
              }),
            );
          }
          return { keyword: q.keyword, ok: true as const, items: trimmed };
        } catch (error) {
          return {
            keyword: q.keyword,
            ok: false as const,
            error: toolErrorMessage(error),
          };
        }
      }),
    );

    const okCount = results.filter((r) => r.ok).length;
    const text =
      results
        .map((r) => {
          if (!r.ok) {
            return `"${r.keyword}": FAILED — ${r.error}`;
          }
          if (r.items.length === 0) {
            return `"${r.keyword}" (0 results)`;
          }
          return `"${r.keyword}" (${r.items.length} results):\n${formatMcpTable(r.items, SERP_ITEM_COLUMNS)}`;
        })
        .join("\n\n") +
      `\n\n${okCount} of ${results.length} queries succeeded.`;

    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/keywords`,
      ),
      structuredContent: { results },
    });
  }),
};

/**
 * A self-hosted install without DataForSEO reads the live SERP from Bright
 * Data, one request from the monthly budget per 10 rows of depth (default
 * one page). Rows are cached like DataForSEO's, so a repeat within 12 hours
 * sends no request. A city name must be in the country's location list
 * (Google Ads' geo targets file) before it goes into uule, so a misspelled
 * city fails without spending a request on country-wide results.
 */
async function getBrightDataSerpResults(
  config: BrightDataSerp,
  args: Args,
  context: {
    baseUrl: string;
    billing: { organizationId: string };
    project: { locationCode: number; languageCode: string };
  },
) {
  const depth = args.depth ?? 10;
  const results = await Promise.all(
    args.queries.map(async (q) => {
      try {
        const market = {
          ...resolveMarket(q, context.project),
          locationName: q.locationName,
        };
        if (q.locationName) {
          await assertLocalResearchLocation(
            market.locationCode,
            q.locationName,
          );
        }
        const source = brightDataSourceNote(market);
        const cacheKey = await buildCacheKey("mcp:serp-results", {
          organizationId: context.billing.organizationId,
          projectId: args.projectId,
          keyword: q.keyword,
          ...market,
          depth,
          provider: "brightdata",
        });
        const cached = brightDataCacheSchema.safeParse(
          await getCached(cacheKey),
        );
        if (cached.success) {
          return {
            keyword: q.keyword,
            ok: true as const,
            ...cached.data,
            source,
            usedThisMonth: null,
          };
        }

        const serp = await fetchBrightDataSerp(config, {
          keyword: q.keyword,
          market,
          device: "desktop",
          depth,
          observation: {
            organizationId: context.billing.organizationId,
            origin: "serp_tool",
          },
        });
        const organic = serp.organic.map(({ position, ...item }) => ({
          type: "organic",
          rank: position,
          ...item,
        }));
        const localPack: LocalPackItem[] = serp.localPack.map((item) => ({
          rank: item.position,
          title: item.title,
          url: item.url,
          rating: item.rating,
          reviews_count: item.reviewsCount,
        }));
        const sections = serpSectionRows(serp);
        if (organic.length > 0 || localPack.length > 0) {
          waitUntil(
            setCached(
              cacheKey,
              { organic, localPack, sections },
              SERP_RESULTS_CACHE_TTL_SECONDS,
            ).catch((error) => {
              console.error("mcp.serp-results.cache-write failed:", error);
            }),
          );
        }
        return {
          keyword: q.keyword,
          ok: true as const,
          organic,
          localPack,
          sections,
          source,
          usedThisMonth: serp.usedThisMonth,
        };
      } catch (error) {
        return {
          keyword: q.keyword,
          ok: false as const,
          error: toolErrorMessage(error),
        };
      }
    }),
  );

  const succeeded = results.filter((r) => r.ok);
  const fresh = succeeded.flatMap((r) => r.usedThisMonth ?? []);
  const blocks = results.map((r) => {
    if (!r.ok) return `"${r.keyword}": FAILED — ${r.error}`;
    const lines = [
      r.organic.length === 0
        ? `"${r.keyword}" (0 organic results)`
        : `"${r.keyword}" (${r.organic.length} organic results):\n${formatMcpTable(r.organic, SERP_ITEM_COLUMNS)}`,
    ];
    if (r.localPack.length > 0) {
      lines.push(
        `Local pack:\n${formatMcpTable(r.localPack, LOCAL_PACK_COLUMNS)}`,
      );
    }
    lines.push(...formatSerpSectionRows(r.sections));
    return lines.join("\n");
  });
  const text = [
    ...blocks,
    `${succeeded.length} of ${results.length} queries succeeded. rank is the position among organic results; rows of the local pack and every other section rank within that section, which comes from the first results page.`,
    ...(succeeded.some((r) => !hasAiOverview(r.sections))
      ? [AI_OVERVIEW_NOT_DETECTED_NOTE]
      : []),
    ...new Set(succeeded.map((r) => r.source)),
    ...(fresh.length > 0 ? [brightDataBudgetLine(Math.max(...fresh))] : []),
    ...(fresh.length < succeeded.length
      ? [
          `${succeeded.length - fresh.length} of ${results.length} queries came from the 12-hour cache and sent no Bright Data request.`,
        ]
      : []),
  ].join("\n\n");

  return mcpResponse({
    text,
    meta: buildProjectMeta(
      context,
      args.projectId,
      `/p/${args.projectId}/keywords`,
    ),
    structuredContent: {
      results: results.map((r) =>
        r.ok
          ? {
              keyword: r.keyword,
              ok: r.ok,
              items: [
                ...r.organic,
                ...r.localPack.map((item) => ({
                  type: "local_pack",
                  domain: null,
                  description: null,
                  ...item,
                })),
                ...r.sections,
              ],
              ai_overview: hasAiOverview(r.sections)
                ? "detected"
                : "not_detected",
              source: r.source,
            }
          : r,
      ),
      provider: "brightdata",
    },
  });
}
