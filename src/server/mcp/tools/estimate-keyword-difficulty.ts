import { z } from "zod";
import {
  MAX_LIVE_ESTIMATES,
  estimateProjectKeywordDifficulty,
} from "@/server/features/serp/services/difficultyEstimate";
import { SAVED_PAGE_MAX_AGE_DAYS } from "@/server/features/serp/services/serpCompetitors";
import {
  brightDataBudgetLine,
  brightDataSourceNote,
} from "@/server/lib/brightDataSerp";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { toolErrorMessage } from "@/server/mcp/tool-error-message";
import { DIFFICULTY_ESTIMATE_LABEL } from "@/shared/keyword-difficulty";

// OpenSEO's own keyword difficulty for self-hosted installs on Bright Data,
// where DataForSEO's is unavailable. Registered only on the self-hosted MCP
// transport.

const inputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(50)
    .describe(
      `1-50 keywords. Keywords with a Google page saved in the last ${SAVED_PAGE_MAX_AGE_DAYS} days (rank checks, get_serp_results, find_serp_competitors) cost nothing; at most ${MAX_LIVE_ESTIMATES} others are searched live per call.`,
    ),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

type EstimateRow = {
  keyword: string;
  keyword_difficulty: number | null;
  local_score: number | null;
  organic_score: number | null;
  page: string;
};

const ESTIMATE_COLUMNS: McpTableColumn<EstimateRow>[] = [
  { header: "keyword", value: (row) => row.keyword },
  { header: "KD", value: (row) => row.keyword_difficulty },
  { header: "local", value: (row) => row.local_score },
  { header: "organic", value: (row) => row.organic_score },
  { header: "page", value: (row) => row.page },
];

export const estimateKeywordDifficultyTool = {
  name: "estimate_keyword_difficulty",
  config: {
    title: "Estimate keyword difficulty",
    description: `${DIFFICULTY_ESTIMATE_LABEL} of keyword difficulty (0-100) on a self-hosted server where Bright Data stands in for DataForSEO, which has no difficulty there. From each keyword's first Google page: the local pack's review counts and, with OPENPAGERANK_API_KEY, the top 10's Open PageRank. Saves each estimate for the project, so research_keywords, list_saved_keywords and get_rank_tracker show it next to the provider's difficulty (as keywordDifficultyEstimate). Tracked keywords get one after each rank check without a call. Uses this server's Bright Data budget, not credits.`,
    inputSchema,
    outputSchema: z.looseObject({
      keywords: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const result = await estimateProjectKeywordDifficulty({
      organizationId: context.billing.organizationId,
      project: context.project,
      keywords: args.keywords,
      locationCode: args.locationCode,
      languageCode: args.languageCode,
    });
    const rows: EstimateRow[] = result.estimates.map((estimate) => ({
      keyword: estimate.keyword,
      keyword_difficulty: estimate.keywordDifficulty,
      local_score: estimate.localScore,
      organic_score: estimate.organicScore,
      page:
        estimate.source === "live"
          ? "searched now"
          : `saved ${estimate.observedAt.slice(0, 10)}`,
    }));

    const lines = [
      `${DIFFICULTY_ESTIMATE_LABEL} of keyword difficulty for ${rows.length} keywords, not DataForSEO data. KD = 0.6 local + 0.4 organic with a local pack, organic alone without one. local = the local pack's median review count on a log scale (about 50 reviews -> 25, 500 -> 58, 3,000 -> 84). organic = the top 10's Open PageRank x10, weighted toward the top results, minus 10 per top-5 result on a social network, forum, directory or delivery platform. "—" = not measured.`,
    ];
    if (rows.length > 0) lines.push(formatMcpTable(rows, ESTIMATE_COLUMNS));
    if (result.authorityUnavailable) {
      lines.push(
        `organic not measured: ${result.authorityUnavailable} Keywords without a local pack then get no KD.`,
      );
    }
    if (result.failed.length > 0) {
      lines.push(
        `Not checked: ${result.failed.map(({ keyword, reason }) => `"${keyword}": ${toolErrorMessage(reason)}`).join("; ")}`,
      );
    }
    if (result.notChecked.length > 0) {
      lines.push(
        `Not checked, past this call's ${MAX_LIVE_ESTIMATES} live searches: ${result.notChecked.join(", ")}. Repeat the call for the next ${MAX_LIVE_ESTIMATES}.`,
      );
    }
    lines.push(
      `Saved pages count from the last ${SAVED_PAGE_MAX_AGE_DAYS} days, on either device; live searches run on ${result.device}.`,
      brightDataSourceNote(result.market),
      result.usedThisMonth == null
        ? "No Bright Data request was sent."
        : brightDataBudgetLine(result.usedThisMonth),
    );

    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/saved`,
      ),
      structuredContent: {
        keywords: [
          ...rows,
          ...result.failed.map(({ keyword, reason }) => ({
            keyword,
            page: "failed",
            error: toolErrorMessage(reason),
          })),
          ...result.notChecked.map((keyword) => ({
            keyword,
            page: "not_checked",
          })),
        ],
        source: "openseo_estimate",
      },
    });
  }),
};
