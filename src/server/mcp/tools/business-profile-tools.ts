import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { GbpService } from "@/server/features/gbp/services/GbpService";
import { hasGoogleOAuthConfig } from "@/server/features/google/oauth-config";
import {
  GbpApiError,
  GbpNotConnectedError,
  GbpTokenError,
} from "@/server/lib/gbpErrors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { buildDashboardUrl } from "@/server/mcp/urls";
import { GBP_SELF_HOSTED_SETUP_DOCS_URL } from "@/shared/gbp";
import {
  formatKeywordsText,
  formatLocationsText,
  formatPerformanceText,
  formatReviewsText,
  GBP_STORAGE_NOTE,
} from "./business-profile-format";

// The owner's own Google Business Profile listings. Registered only on the
// self-hosted MCP transport; GbpService also refuses hosted mode.

const OWNER_VIEW =
  "Reads your own listings (owner view) under the Business Profile account connected to the project; for competitors use search_local_businesses / get_business_reviews. Self-hosted installs only. Read-only; uses no credits.";

const READ_ONLY = {
  readOnlyHint: true,
  openWorldHint: true,
  destructiveHint: false,
} as const;

const locationSchema = z
  .string()
  .regex(/^locations\/\d+$/)
  .optional()
  .describe(
    "Location resource name (locations/123) from list_google_business_profile_locations. Optional when the account has one location, or one whose website is the project's domain.",
  );

const outputSchema = (shape: z.ZodRawShape) =>
  z.looseObject({
    ok: z.boolean(),
    reason: z.string().optional(),
    connectUrl: z.string().optional(),
    setupDocsUrl: z.string().optional(),
    storageNote: z.string().optional(),
    location: z.string().optional(),
    title: z.string().optional(),
    ...shape,
    ...optionalMetaOutputSchema,
  });

type ProjectContext = {
  baseUrl: string;
  project: { domain: string | null };
};

function describeFailure(error: unknown) {
  if (error instanceof GbpNotConnectedError) {
    return {
      reason: "not_connected",
      message: "Google Business Profile is not connected for this project.",
    };
  }
  if (
    error instanceof GbpTokenError ||
    (error instanceof GbpApiError && error.reason === "reconnect")
  ) {
    return {
      reason: "reconnect_required",
      message:
        "The Google Business Profile connection expired or was revoked. Reconnect it.",
    };
  }
  if (error instanceof GbpApiError) {
    const reason =
      error.reason === "api_access_pending" ||
      error.reason === "permission_denied"
        ? error.reason
        : "api_error";
    return { reason, message: error.message };
  }
  return null;
}

/** Shared envelope: setup nudge, success with the storage note, or a
 *  structured failure the agent can act on. Other errors propagate. */
async function runGbpTool(
  projectId: string,
  context: ProjectContext,
  run: () => Promise<{
    text: string;
    structuredContent: Record<string, unknown>;
  }>,
): Promise<CallToolResult> {
  const meta = buildProjectMeta(
    context,
    projectId,
    `/p/${projectId}/settings/integrations`,
  );
  if (!(await hasGoogleOAuthConfig())) {
    return mcpResponse({
      text: `This self-hosted OpenSEO deployment is not configured for Google Business Profile yet. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and BETTER_AUTH_SECRET, then connect Business Profile from the project's settings page. Setup docs: ${GBP_SELF_HOSTED_SETUP_DOCS_URL}`,
      meta,
      structuredContent: {
        ok: false,
        reason: "oauth_not_configured",
        setupDocsUrl: GBP_SELF_HOSTED_SETUP_DOCS_URL,
      },
    });
  }
  try {
    const result = await run();
    return mcpResponse({
      text: `${result.text}\n\n${GBP_STORAGE_NOTE}`,
      meta,
      structuredContent: {
        ok: true,
        ...result.structuredContent,
        storageNote: GBP_STORAGE_NOTE,
      },
    });
  } catch (error) {
    const failure = describeFailure(error);
    if (!failure) throw error;
    const connectUrl = buildDashboardUrl(
      context.baseUrl,
      `/p/${projectId}/settings/integrations#business-profile`,
    );
    const next =
      failure.reason === "api_access_pending"
        ? `Setup docs: ${GBP_SELF_HOSTED_SETUP_DOCS_URL}`
        : `Manage the connection at ${connectUrl}`;
    return mcpResponse({
      text: `${failure.message} ${next}`,
      meta,
      structuredContent: {
        ok: false,
        reason: failure.reason,
        connectUrl,
        setupDocsUrl: GBP_SELF_HOSTED_SETUP_DOCS_URL,
      },
    });
  }
}

const listLocationsInput = { projectId: projectIdSchema } as const;

export const listGoogleBusinessProfileLocationsTool = {
  name: "list_google_business_profile_locations",
  config: {
    title: "List Google Business Profile locations",
    description: `List the locations (branches or brands) under the project's connected Google Business Profile account: resource name, title, primary category, address, open status, Place ID and Maps link. Call it first when the account has several locations, then pass \`location\` to the other get_google_business_profile_* tools. placeId feeds get_local_rank_grid target.placeId. ${OWNER_VIEW}`,
    inputSchema: listLocationsInput,
    outputSchema: outputSchema({
      accountName: z.string().optional(),
      accountDisplayName: z.string().optional(),
      locations: z.array(looseObjectOutputSchema).optional(),
    }),
    annotations: READ_ONLY,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof listLocationsInput>>, context) =>
      runGbpTool(args.projectId, context, async () => {
        const result = await GbpService.listLocations(args.projectId);
        return {
          text: formatLocationsText(result),
          structuredContent: result,
        };
      }),
  ),
};

const reviewsInput = {
  projectId: projectIdSchema,
  location: locationSchema,
  orderBy: z
    .enum(["newest", "lowest", "highest"])
    .optional()
    .describe("Sort order (default newest)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Reviews to return (default 50, max 200)."),
  unansweredOnly: z
    .boolean()
    .optional()
    .describe(
      "Only reviews without an owner reply, taken from the first 200 reviews in the chosen order.",
    ),
} as const;

export const getGoogleBusinessProfileReviewsTool = {
  name: "get_google_business_profile_reviews",
  config: {
    title: "Get Google Business Profile reviews",
    description: `Read reviews of one of your locations with the owner's reply: rating 1–5, text, dates, reviewer name and reply, plus the location's average rating, total review count and how many fetched reviews have no reply. Use it to find unanswered or low-rated reviews and to draft replies (OpenSEO never posts them). ${OWNER_VIEW}`,
    inputSchema: reviewsInput,
    outputSchema: outputSchema({
      averageRating: z.number().nullable().optional(),
      totalReviewCount: z.number().optional(),
      fetchedCount: z.number().optional(),
      unansweredCount: z.number().optional(),
      reviews: z.array(looseObjectOutputSchema).optional(),
    }),
    annotations: READ_ONLY,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof reviewsInput>>, context) =>
      runGbpTool(args.projectId, context, async () => {
        const orderBy = args.orderBy ?? "newest";
        const unansweredOnly = args.unansweredOnly ?? false;
        const result = await GbpService.getReviews({
          projectId: args.projectId,
          location: args.location,
          projectDomain: context.project.domain,
          orderBy,
          limit: args.limit ?? 50,
          unansweredOnly,
        });
        return {
          text: formatReviewsText(result, { orderBy, unansweredOnly }),
          structuredContent: result,
        };
      }),
  ),
};

const dateSchema = z.iso.date();

const performanceInput = {
  projectId: projectIdSchema,
  location: locationSchema,
  startDate: dateSchema
    .optional()
    .describe("Inclusive start, YYYY-MM-DD. Provide with endDate."),
  endDate: dateSchema
    .optional()
    .describe("Inclusive end, YYYY-MM-DD. Provide with startDate."),
} as const;

export const getGoogleBusinessProfilePerformanceTool = {
  name: "get_google_business_profile_performance",
  config: {
    title: "Get Google Business Profile performance",
    description: `Daily Business Profile performance for one of your locations: impressions split by Search/Maps and mobile/desktop, direction requests, call, website, messaging and menu clicks, and bookings. Returns totals and one row per day (days Google omits are 0). Default range: the 28 days ending 3 days ago (Google's data lag); at most 92 days. ${OWNER_VIEW}`,
    inputSchema: performanceInput,
    outputSchema: outputSchema({
      range: looseObjectOutputSchema.optional(),
      totals: looseObjectOutputSchema.optional(),
      daily: z.array(looseObjectOutputSchema).optional(),
    }),
    annotations: READ_ONLY,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof performanceInput>>, context) =>
      runGbpTool(args.projectId, context, async () => {
        const result = await GbpService.getPerformance({
          projectId: args.projectId,
          location: args.location,
          projectDomain: context.project.domain,
          startDate: args.startDate,
          endDate: args.endDate,
        });
        return {
          text: formatPerformanceText(result),
          structuredContent: result,
        };
      }),
  ),
};

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const keywordsInput = {
  projectId: projectIdSchema,
  location: locationSchema,
  startMonth: monthSchema
    .optional()
    .describe("First month, YYYY-MM. Provide with endMonth."),
  endMonth: monthSchema
    .optional()
    .describe("Last month, YYYY-MM. Provide with startMonth."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Keywords to return (default 100, max 500)."),
} as const;

export const getGoogleBusinessProfileSearchKeywordsTool = {
  name: "get_google_business_profile_search_keywords",
  config: {
    title: "Get Google Business Profile search keywords",
    description: `The search terms people used on Google Search and Maps when your listing appeared, summed over a month range (default: the last 3 complete months). impressions is Google's count of people per term; when the count is too small to report, impressions is null and impressionsBelow holds Google's threshold. ${OWNER_VIEW}`,
    inputSchema: keywordsInput,
    outputSchema: outputSchema({
      range: looseObjectOutputSchema.optional(),
      keywords: z.array(looseObjectOutputSchema).optional(),
    }),
    annotations: READ_ONLY,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof keywordsInput>>, context) =>
      runGbpTool(args.projectId, context, async () => {
        const result = await GbpService.getSearchKeywords({
          projectId: args.projectId,
          location: args.location,
          projectDomain: context.project.domain,
          startMonth: args.startMonth,
          endMonth: args.endMonth,
          limit: args.limit ?? 100,
        });
        return {
          text: formatKeywordsText(result),
          structuredContent: result,
        };
      }),
  ),
};
