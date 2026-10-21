import { z } from "zod";
import { KeywordResearchService } from "@/server/features/keywords/services/KeywordResearchService";
import type { EnrichedKeyword } from "@/server/features/keywords/services/research/helpers";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { resolveMarket } from "@/shared/keyword-locations";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { assertLanguageForLocation } from "@/server/lib/market";
import {
  getKeywordPlannerConfig,
  KEYWORD_PLANNER_SOURCE_NOTE,
} from "@/server/lib/keywordPlannerConfig";
import { toolErrorMessage } from "@/server/mcp/tool-error-message";
import {
  AUTUMN_SEO_DATA_CREDITS_PER_USD,
  LOCAL_VOLUME_COST_USD,
  applyBillingMarkupUsd,
} from "@/shared/billing";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import {
  DIFFICULTY_ESTIMATE_NOTE,
  difficultyCell,
  isEstimatedDifficulty,
} from "@/shared/keyword-difficulty";

const LOCAL_VOLUME_CREDITS = Math.ceil(
  applyBillingMarkupUsd(LOCAL_VOLUME_COST_USD) *
    AUTUMN_SEO_DATA_CREDITS_PER_USD,
);

const seedSchema = z.object({
  seed: z.string().min(1).describe("Seed keyword to research."),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
  locationName: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Optional city, county, or region inside the seed's country, for local search volume. Call search_serp_locations first and pass its locationName verbatim. Volume, CPC, and competition then come from Google Ads for that area; keyword ideas, KD, and intent stay national. Adds ~${LOCAL_VOLUME_CREDITS} credits per seed.`,
    ),
});

const inputSchema = {
  projectId: projectIdSchema,
  seeds: z
    .array(seedSchema)
    .min(1)
    .max(5)
    .describe(
      "1-5 seed keywords. Each seed is researched independently and returns related keywords with volume/difficulty/CPC. Bulk-friendly — prefer this over multiple single-seed calls.",
    ),
  resultLimit: z
    .union([z.literal(150), z.literal(300), z.literal(500)])
    .optional()
    .describe(
      "Max keywords returned per seed. Defaults to 150. Auto mode blends two sources; duplicate keywords across sources appear once.",
    ),
  includeClickstreamData: z
    .boolean()
    .optional()
    .describe(
      "Refine search volumes with clickstream data, which disaggregates Google Ads' grouped close-variant volumes (plurals/misspellings). DOUBLES the credit cost of each seed. Default false (standard Google-Ads-derived volumes). No effect for countries served from Google Ads data.",
    ),
  groupKeywords: z
    .boolean()
    .optional()
    .describe(
      "Include similar keyword variants that can share volume, CPC, and competition. Default false returns only core keywords (DataForSEO ignore_synonyms=true). True includes variants (ignore_synonyms=false). This filters keywords, not metric estimates. Do not sum shared volumes. No effect for countries served from Google Ads data.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

type ResearchRow = {
  keyword: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  keywordDifficultyEstimate?: number | null;
  cpc: number | null;
  competition: number | null;
  intent: string;
};

// The 12-month trend array is ~80% of the bytes per row and no MCP consumer
// reads it; get_keyword_metrics returns trends for the few keywords that need
// them.
function toResearchRow(row: EnrichedKeyword): ResearchRow {
  return {
    keyword: row.keyword,
    searchVolume: row.searchVolume,
    keywordDifficulty: row.keywordDifficulty,
    ...(row.keywordDifficultyEstimate == null
      ? {}
      : { keywordDifficultyEstimate: row.keywordDifficultyEstimate }),
    cpc: row.cpc,
    competition: row.competition,
    intent: row.intent,
  };
}

// The rows also ship in structuredContent; this table exists so MCP clients
// that surface only text content see every keyword and its metrics, not just
// the count summary.
const RESEARCH_COLUMNS: McpTableColumn<ResearchRow>[] = [
  { header: "keyword", value: (row) => row.keyword },
  { header: "volume", value: (row) => row.searchVolume },
  { header: "KD", value: difficultyCell },
  { header: "CPC", value: (row) => row.cpc },
  { header: "competition", value: (row) => row.competition },
  { header: "intent", value: (row) => row.intent },
];

export const researchKeywordsTool = {
  name: "research_keywords",
  config: {
    title: "Research keywords (bulk)",
    description:
      "Research keyword data (search volume, difficulty, CPC, related ideas) for 1-5 seed keywords in one call. Charges credits per seed (~54 at the default result limit, ~110 at 500, plus ~40 more (~95 at 500) when an obscure seed needs a fallback lookup; flat ~96 for countries served from Google Ads data, where difficulty/intent are unavailable). Returns per-seed results — a single bad seed won't fail the batch.",
    inputSchema,
    outputSchema: z.looseObject({
      results: z.array(
        z.union([
          z
            .object({
              seed: z.string(),
              ok: z.literal(true),
              rowCount: z.number(),
              source: z.string(),
              usedFallback: z.boolean(),
              rows: z.array(looseObjectOutputSchema),
            })
            .passthrough(),
          z
            .object({
              seed: z.string(),
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
    const plannerConfig = await getKeywordPlannerConfig();
    const results = await Promise.all(
      args.seeds.map(async (item) => {
        try {
          const { locationCode, languageCode } = resolveMarket(
            item,
            context.project,
          );
          assertLanguageForLocation(locationCode, languageCode);
          const data = await KeywordResearchService.research(
            {
              projectId: args.projectId,
              keywords: [item.seed],
              locationCode,
              languageCode,
              locationName: item.locationName,
              resultLimit: args.resultLimit ?? 150,
              mode: "auto",
              clickstream: args.includeClickstreamData ?? false,
              groupKeywords: args.groupKeywords ?? false,
            },
            context.billing,
          );
          return {
            seed: item.seed,
            ok: true as const,
            locationName: item.locationName,
            rowCount: data.rows.length,
            source: data.source,
            usedFallback: data.usedFallback,
            rows: data.rows.map(toResearchRow),
          };
        } catch (error) {
          return {
            seed: item.seed,
            ok: false as const,
            // search_serp_locations needs DataForSEO, which a Keyword
            // Planner install lacks.
            error:
              plannerConfig && error instanceof Error
                ? error.message
                : toolErrorMessage(error),
          };
        }
      }),
    );

    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    const sourceNote =
      plannerConfig && okCount > 0 ? `\n${KEYWORD_PLANNER_SOURCE_NOTE}` : "";
    const estimateNote = results.some(
      (result) => result.ok && result.rows.some(isEstimatedDifficulty),
    )
      ? `\n${DIFFICULTY_ESTIMATE_NOTE}`
      : "";
    const text =
      results
        .map((r) => {
          if (!r.ok) {
            return `## "${r.seed}" — FAILED\n${r.error}`;
          }
          const scope = r.locationName
            ? `, volume/CPC/competition for ${r.locationName}, KD/intent national`
            : "";
          const header = `## "${r.seed}" — ${r.rowCount} keywords (source: ${r.source}${r.usedFallback ? ", fallback" : ""}${scope})`;
          if (r.rowCount === 0) {
            return `${header}\n(no keywords returned)`;
          }
          return `${header}\n${formatMcpTable(r.rows, RESEARCH_COLUMNS)}`;
        })
        .join("\n\n") +
      `\n\nResearched ${okCount} of ${results.length} seeds${failCount > 0 ? ` (${failCount} failed)` : ""}. Columns: volume = monthly searches, KD = keyword difficulty (0-100), CPC in USD, competition = paid competition (0-1); "—" = unavailable. Google Ads close variants may share search volumes; do not add their volumes together.${sourceNote}${estimateNote}`;

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
