import { z } from "zod";

export const suggestedAiTopicSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(
      /^\S+(?:\s+\S+){0,4}$/,
      "Generated topic names must contain five words or fewer.",
    )
    .describe("A succinct topic name, at most five words"),
  prompts: z.array(z.string().trim().min(1).max(500)).length(5),
});
export const generateAiPromptsSchema = z.object({
  projectId: z.string().uuid(),
  topic: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe(
      "A saved topic to add prompts to, or a new topic name. Omit to let the model name a new topic.",
    ),
  excludePrompts: z.array(z.string().trim().max(2000)).max(10).default([]),
  locationCode: z.number().int().positive(),
  languageCode: z.string().trim().min(2).max(10),
});
export const aiPromptSuggestionsSchema = z.looseObject({
  topic: z.string(),
  // Empty only without a model, when Google offered nothing new.
  prompts: z.array(z.string()).max(5),
  // Set only on a self-hosted server without an AI model: prompts are then
  // Google's questions and related searches for the topic, not drafts.
  withoutModel: z.looseObject({ guidance: z.string() }).optional(),
});
export type GenerateAiPromptsInput = z.infer<typeof generateAiPromptsSchema>;
