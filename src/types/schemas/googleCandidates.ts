import { z } from "zod";

/**
 * One live Google first page, reduced to what a person or their own AI agent
 * needs to pick competitors, keywords and prompts by hand: organic results,
 * the local pack, People Also Ask questions and related searches.
 */
export const googleSearchCandidatesSchema = z.object({
  query: z.string(),
  /** The city the search ran near, or null for the whole country. */
  locationName: z.string().nullable(),
  organic: z.array(
    z.object({
      title: z.string().nullable(),
      url: z.string().nullable(),
      domain: z.string().nullable(),
      description: z.string().nullable(),
    }),
  ),
  localPack: z.array(
    z.object({
      name: z.string().nullable(),
      url: z.string().nullable(),
      domain: z.string().nullable(),
      rating: z.number().nullable(),
      reviewsCount: z.number().nullable(),
    }),
  ),
  /** Each question with Google's answer snippet and the page it cites. */
  peopleAlsoAsk: z.array(
    z.object({
      question: z.string(),
      answer: z.string().nullable(),
      url: z.string().nullable(),
      domain: z.string().nullable(),
    }),
  ),
  relatedSearches: z.array(z.string()),
});

export type GoogleSearchCandidates = z.infer<
  typeof googleSearchCandidatesSchema
>;
