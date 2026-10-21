import { z } from "zod";
import { suggestedAiTopicSchema } from "./aiPromptSuggestions";
import { googleSearchCandidatesSchema } from "./googleCandidates";
import { PROSE_MAX_CHARS } from "./projectContext";

const domain = z.string().trim().min(1).max(255);
export const MAX_SUGGESTED_KEYWORDS = 15;
// AI visibility setup matches this text to tell users why its workflow failed.
export const WEBSITE_UNREADABLE_MESSAGE =
  "We couldn't read this website. Check the URL and try again.";
const researchKeywordSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^\S+(?:\s+\S+){0,4}$/, "Keywords must contain five words or fewer.");
const websiteCompetitorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  domain,
  notes: z.string().trim().min(1).max(500),
  sourceUrl: z.string().url(),
});
// A self-hosted server without an AI model cannot write the overview,
// verify competitors or draft topics. Its research returns the raw material
// instead, for the user or their own AI agent (over MCP) to finish.
const websiteCandidatesSchema = z.object({
  /** The fields that were not saved yet, so someone has to fill them. */
  missing: z.object({
    overview: z.boolean(),
    competitors: z.boolean(),
    keywords: z.boolean(),
  }),
  /** Next steps for an AI agent finishing setup over MCP. */
  guidance: z.string(),
  /** The website pages read, when the overview is missing. */
  sitePages: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullable(),
      text: z.string(),
    }),
  ),
  /** Live Google results for the project's tracked keywords. */
  searches: z.array(googleSearchCandidatesSchema),
});
export const websiteResearchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  domain,
  overview: z.string().trim().min(1).max(PROSE_MAX_CHARS),
  competitors: z.array(websiteCompetitorSchema).max(5),
  preserveCompetitors: z.boolean(),
  // The first three topics seed tracking. All topic names and the suggested
  // keywords become Prompt Research keywords.
  suggestedTopics: z.array(suggestedAiTopicSchema).max(5),
  suggestedKeywords: z.array(researchKeywordSchema).max(MAX_SUGGESTED_KEYWORDS),
  // Set only when no model ran: overview is then a raw excerpt of the
  // homepage when it was missing, competitors is empty, suggestedTopics is
  // empty and suggestedKeywords are Google's own candidates.
  withoutModel: websiteCandidatesSchema.optional(),
});
export const researchProjectWebsiteSchema = z.object({
  projectId: z.string().uuid(),
  website: z.string().trim().min(1).max(2000),
});
export const saveProjectWebsiteSetupSchema = websiteResearchSchema
  .omit({
    suggestedTopics: true,
    suggestedKeywords: true,
    preserveCompetitors: true,
    withoutModel: true,
  })
  .extend({
    projectId: z.string().uuid(),
    suggestedTopics: z.array(suggestedAiTopicSchema).max(5).optional(),
    suggestedKeywords: websiteResearchSchema.shape.suggestedKeywords.optional(),
    competitors: z
      .array(
        websiteCompetitorSchema.omit({ sourceUrl: true }).extend({
          notes: z.string().trim().max(500).default(""),
        }),
      )
      .max(100),
  });
export type WebsiteResearch = z.infer<typeof websiteResearchSchema>;
export type SaveProjectWebsiteSetup = z.infer<
  typeof saveProjectWebsiteSetupSchema
>;
