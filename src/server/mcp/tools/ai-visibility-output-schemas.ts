import { z } from "zod";
import { aiEngineSchema as engine } from "@/types/schemas/ai-visibility";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";

const text = z.string();
const nullableText = text.nullable();
const count = z.number().int().nonnegative();
const money = z.number().nonnegative();
const flag = z.boolean();
const coverage = z.looseObject({
  expected: count,
  completed: count,
  failed: count,
  pending: count,
});
export const aiRunOutput = z.looseObject({
  id: text,
  status: z.enum(["queued", "running", "completed", "partial", "failed"]),
  trigger: z.enum(["baseline", "scheduled", "manual"]),
  ...coverage.shape,
  createdAt: text,
  completedAt: nullableText,
  pollAfterSeconds: count,
});
export const aiTrackerOutput = z.looseObject({
  configured: flag,
  providerConfigured: flag,
  tracker: z
    .looseObject({
      id: text,
      projectId: text,
      enabled: flag,
      locationCode: count,
      languageCode: text,
      scheduleInterval: text,
      nextCheckAt: nullableText,
      lastSkipReason: nullableText,
      createdAt: text,
    })
    .nullable(),
  topics: z.array(text),
  prompts: z.array(
    z.looseObject({
      id: text,
      text,
      topic: text,
      paused: flag,
      archived: flag,
      branded: flag,
      hasResults: flag,
    }),
  ),
  brands: z.array(z.looseObject({ name: text, domain: text, own: flag })),
  engines: z.array(engine),
  capabilities: z.array(
    z.looseObject({
      engine,
      label: text,
      unsupportedLocationCodes: z.array(count),
      maxPromptLength: count,
      note: text,
      modelApi: flag,
    }),
  ),
  recentRuns: z.array(aiRunOutput),
});
export const aiCostOutput = z.looseObject({
  promptCount: count,
  engineCount: count,
  observations: count,
  providerCostUsd: money,
  costUsd: money,
  costCredits: money,
  runNowCostUsd: money,
  runNowCostCredits: money,
  scheduleInterval: text,
  checksPerMonth: count,
  monthlyCostUsd: money,
  currency: z.literal("USD"),
  warnings: z.array(text),
  searchBudget: z
    .looseObject({
      perCheck: count,
      perMonth: count,
      monthlyBudget: count,
      hourlyLimit: count,
      usedThisMonth: count,
      remaining: count,
    })
    .nullable()
    .describe(
      "Self-hosted Google AI Mode through SerpApi only: the free searches one check uses (at most hourlyLimit) and the schedule's busiest month uses together with the server's other AI Mode trackers, against this server's shared monthly budget. Null otherwise.",
    ),
  brightDataBudget: z
    .looseObject({
      perCheck: count,
      perMonth: count,
      monthlyBudget: count,
      usedThisMonth: count,
      remaining: count,
    })
    .nullable()
    .describe(
      "Self-hosted Google AI Overviews through Bright Data only: the free requests one check uses and the schedule's busiest month uses together with the server's other AI Overviews trackers, against this server's monthly Bright Data budget, which rank tracking and SERP tools also use. Null otherwise.",
    ),
});
const observation = z.looseObject({
  id: text,
  runId: text,
  promptId: text,
  prompt: text,
  topic: text,
  branded: flag,
  engine,
  status: z.enum(["pending", "completed", "failed"]),
  brands: z.array(
    z.looseObject({
      name: text,
      domain: text,
      own: flag,
      mentioned: flag,
      cited: flag,
      firstMention: count.nullable(),
    }),
  ),
  answerStatus: z.enum(["answered", "no_answer"]).nullable(),
  citationCount: count,
  collectedAt: nullableText,
  error: nullableText.describe(
    "Why a failed collection failed. On a no_answer collection, why it has no answer when the provider said, such as a Google AI Overview that Bright Data returned without its text; it still counts as no answer, not as a missing brand.",
  ),
});
export const aiResultsOutput = z.looseObject({
  runId: nullableText,
  run: aiRunOutput.nullable(),
  rows: z.array(observation),
  totalCount: count,
  nextCursor: nullableText,
  summaries: z.array(
    z.looseObject({
      name: text,
      domain: text,
      own: flag,
      answers: count,
      mentions: count,
      citations: count,
      positionTotal: count,
      positionCount: count,
    }),
  ),
  coverage: coverage.extend({ noAnswer: count }),
  appliedFilters: z.looseObject({
    topic: text.optional(),
    engines: z.array(engine).optional(),
    competitorGap: flag,
    branded: text,
  }),
  truncated: flag,
});
export const aiAnswerOutput = z.looseObject({
  observation,
  answerText: nullableText,
  answerMarkdown: nullableText,
  sources: z.array(
    z.looseObject({
      url: text,
      domain: text,
      title: nullableText,
      position: count,
      placement: z.enum(["inline", "reference"]).nullable(),
      inlineOrder: count.nullable(),
    }),
  ),
  mentions: z.array(
    z.looseObject({
      domain: text,
      spans: z.array(z.looseObject({ start: count, end: count })),
    }),
  ),
  requestedLocationCode: count,
  requestedLanguageCode: text,
  truncated: flag,
});
export const aiSourcesOutput = z.looseObject({
  runId: nullableText,
  rows: z.array(
    z.looseObject({
      key: text,
      url: nullableText,
      domain: text,
      title: nullableText,
      ownership: z.enum(["own", "competitor", "other"]),
      answerCount: count,
      promptCount: count,
      promptIds: z.array(text),
      engines: z.array(z.looseObject({ engine, answerCount: count })),
      observationIds: z.array(text),
      truncated: flag,
    }),
  ),
  totalCount: count,
  nextCursor: nullableText,
  coverage: coverage.extend({ noAnswer: count }),
  appliedFilters: aiResultsOutput.shape.appliedFilters.extend({
    ownership: z.enum(["all", "own", "competitor", "other"]),
  }),
  groupBy: z.enum(["url", "domain"]),
  truncated: flag,
});
const rate = z.number().min(0).max(100).nullable();
const trendCoverage = z.looseObject({
  runs: count,
  expected: count,
  answered: count,
  noAnswer: count,
  failed: count,
});
const trendPeriod = z.looseObject({
  start: text,
  end: text,
  coverage: trendCoverage,
});
const trendMetric = z.looseObject({
  current: rate,
  previous: rate,
  change: z.number().min(-100).max(100).nullable(),
  matchedCells: count,
  currentCells: count,
  previousCells: count,
});
export const aiTrendOutput = z.looseObject({
  days: count,
  comparison: z.enum([
    "comparable",
    "incomplete",
    "scope_changed",
    "no_previous",
    "no_data",
  ]),
  current: trendPeriod,
  previous: trendPeriod,
  mentions: trendMetric,
  citations: trendMetric,
  engines: z.array(
    z.looseObject({ engine, mentions: trendMetric, citations: trendMetric }),
  ),
  runs: z.array(
    z.looseObject({
      runId: text,
      createdAt: text,
      mentionRate: rate,
      citationRate: rate,
      coverage: trendCoverage,
    }),
  ),
});
export const aiExportOutput = z.looseObject({
  url: text,
  expiresAt: text,
  format: z.enum(["json", "csv"]),
});

// A root object keeps MCP's output contract compatible with SDK clients while
// retaining a concrete schema for every successful payload and safe error.
export function aiToolOutput<T extends z.ZodType>(data: T) {
  return z
    .looseObject({
      status: z.enum(["success", "error"]),
      data: data.optional(),
      code: text.optional(),
      message: text.optional(),
      recovery: text.optional(),
      runId: text.optional(),
      ...optionalMetaOutputSchema,
    })
    .superRefine((value, ctx) => {
      if (value.status === "success" && value.data === undefined)
        ctx.addIssue({
          code: "custom",
          message: "Success requires data",
          path: ["data"],
        });
      if (
        value.status === "error" &&
        (!value.code || !value.message || !value.recovery)
      )
        ctx.addIssue({
          code: "custom",
          message: "Error requires code, message, and recovery",
        });
    });
}
export const aiPromptResearchOutput = z.looseObject({
  keyword: text,
  prompts: z.array(
    z.looseObject({
      text,
      variants: z
        .array(text)
        .describe("Near-duplicate prompts merged into this one."),
      sources: z.array(
        z.looseObject({
          domain: text,
          url: text,
          title: nullableText,
          own: flag,
        }),
      ),
      ownDomainCited: flag,
      brandMentioned: flag,
      tracked: flag,
      origins: z
        .array(
          z.enum([
            "tracked",
            "people_also_ask",
            "related_search",
            "autocomplete",
            "search_console",
            "business_profile",
          ]),
        )
        .optional()
        .describe("Google candidates only: where Google showed this text."),
      volume: z
        .looseObject({
          source: z.enum([
            "business_profile",
            "search_console",
            "keyword_planner",
          ]),
          value: count,
          below: flag.describe("Business Profile reports fewer than value."),
        })
        .nullable()
        .optional()
        .describe(
          "Google candidates only: Business Profile search impressions (last 3 complete months), the site's Search Console impressions (last 3 months), or Keyword Planner average monthly searches. Never AI prompt volume.",
        ),
      answer: z
        .looseObject({
          kind: z.enum(["last_answer", "people_also_ask"]),
          engine: engine.optional(),
          collectedAt: nullableText.optional(),
          text,
        })
        .nullable()
        .optional()
        .describe(
          "Google candidates only: a tracked prompt's last collected answer (shortened), else Google's People Also Ask answer, which is not an AI answer.",
        ),
    }),
  ),
  withoutModel: z
    .looseObject({ guidance: text, notes: z.array(text) })
    .optional()
    .describe(
      "Set when prompts are Google's raw candidates: guidance says how to rewrite them; notes say which sources are missing and why.",
    ),
});
