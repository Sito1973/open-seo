import { z } from "zod";
import { DomainService } from "@/server/features/domain/services/DomainService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { resolveLabsMarket } from "@/shared/keyword-locations";
import {
  formatMcpTable,
  readPath,
  type McpTableColumn,
} from "@/server/mcp/table";
import {
  assertLabsLocationCode,
  assertLanguageForLocation,
} from "@/server/lib/market";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import {
  RESEARCH_SCOPE_PARAM_DESCRIPTION,
  researchScopeSchema,
} from "@/shared/researchScope";
import { parseResearchTargetOrThrow } from "@/server/lib/domainUtils";
import { searchConsoleNote } from "@/server/features/domain/services/searchConsoleDomain";

const SUGGESTION_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "keyword", value: (row) => readPath(row, "keyword") },
  { header: "position", value: (row) => readPath(row, "position") },
  { header: "volume", value: (row) => readPath(row, "searchVolume") },
  { header: "KD", value: (row) => readPath(row, "keywordDifficulty") },
];

const SEARCH_CONSOLE_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "keyword", value: (row) => readPath(row, "keyword") },
  { header: "avg position", value: (row) => readPath(row, "position") },
  { header: "clicks", value: (row) => readPath(row, "traffic") },
  { header: "volume", value: (row) => readPath(row, "searchVolume") },
];

const inputSchema = {
  projectId: projectIdSchema,
  domain: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      "Competitor or reference domain or URL to extract keywords from.",
    ),
  scope: researchScopeSchema
    .optional()
    .describe(RESEARCH_SCOPE_PARAM_DESCRIPTION),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getDomainKeywordSuggestionsTool = {
  name: "get_domain_keyword_suggestions",
  config: {
    title: "Get domain keyword opportunities",
    description:
      "Returns the organic keywords a domain ranks for, including position and available metrics. Use after get_domain_overview when you want the detailed keyword opportunity list for a competitor or reference domain. Charges credits (~100-300 typical). Cached for 12 hours.",
    inputSchema,
    outputSchema: z.looseObject({
      keywords: z.array(looseObjectOutputSchema),
      target: z.string().optional(),
      scope: researchScopeSchema.optional(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const { locationCode, languageCode } = resolveLabsMarket(
      args,
      context.project,
    );
    assertLabsLocationCode(locationCode);
    assertLanguageForLocation(locationCode, languageCode);
    const suggestions = await DomainService.getSuggestedKeywords(
      {
        domain: args.domain,
        scope: args.scope,
        locationCode,
        languageCode,
        organizationId: context.auth.organizationId,
        projectId: args.projectId,
      },
      context.billing,
    );
    const { keywords, dataSource, searchConsole } = suggestions;
    // The service already parsed the same input, so this cannot throw here.
    const parsed = parseResearchTargetOrThrow(args.domain, args.scope);
    const target = parsed.display;
    const scope = parsed.scope;
    const targetLabel = `${target} (scope: ${scope})`;
    const rankedText =
      keywords.length === 0
        ? `No ranked keywords found for ${targetLabel}.`
        : `Keywords for ${targetLabel} (${keywords.length}):\n${formatMcpTable(keywords, searchConsole ? SEARCH_CONSOLE_COLUMNS : SUGGESTION_COLUMNS)}`;
    const text = searchConsole
      ? `${searchConsoleNote(searchConsole, target)}\n${rankedText}`
      : rankedText;
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/domain`,
        {
          domain: target,
          ...(scope ? { scope } : {}),
        },
      ),
      structuredContent: {
        keywords,
        target,
        scope,
        ...(searchConsole ? { dataSource, searchConsole } : {}),
      },
    });
  }),
};
