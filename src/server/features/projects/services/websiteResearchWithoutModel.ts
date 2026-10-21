import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import {
  projectSearchTracker,
  searchGoogleCandidates,
} from "@/server/features/serp/services/googleCandidates";
import { getBrightDataSerp } from "@/server/lib/brightDataSerp";
import { normalizeAiSuggestion } from "@/shared/ai-prompt-suggestions";
import {
  MAX_SUGGESTED_KEYWORDS,
  websiteResearchSchema,
  type WebsiteResearch,
} from "@/types/schemas/projectWebsite";

// Bright Data requests per run: the first tracked keywords that are not the
// brand's own name.
const MAX_SEARCHES = 2;
const PAGE_TEXT_CHARS = 1500;
const OVERVIEW_EXCERPT_CHARS = 600;

type Missing = { overview: boolean; competitors: boolean; keywords: boolean };

/** A search for the brand itself finds the brand, not its competitors. */
function isBrandSearch(
  keyword: string,
  brand: { name: string; domain: string },
) {
  const text = normalizeAiSuggestion(keyword);
  return [normalizeAiSuggestion(brand.name), brand.domain.split(".")[0]].some(
    (term) => term.length > 2 && text.includes(term),
  );
}

function guidanceFor(
  missing: Missing,
  searched: boolean,
  failedQueries: string[],
) {
  const steps = [
    missing.overview &&
      "Write a two-to-four sentence business overview from sitePages: overview holds only a raw excerpt of the homepage.",
    missing.competitors &&
      (searched
        ? "Pick up to five businesses that sell the same thing to the same customers from searches; the local pack lists nearby businesses. Directories, delivery apps, social networks and media are not competitors. Run get_serp_results for more searches if these are not enough."
        : "Run get_serp_results for one or two searches a customer would type to find this kind of business (for a restaurant, its dish or cuisine and its city), then pick up to five businesses that sell the same thing to the same customers. Directories, delivery apps, social networks and media are not competitors."),
    missing.keywords &&
      "Draft five topics of one to three words, most important first, each with five distinct questions a customer would ask an AI assistant when choosing this kind of business, in the project's language and country, without the brand name. Add up to fifteen more short keywords. suggestedKeywords, relatedSearches and peopleAlsoAsk are Google's own candidates to start from.",
  ].filter((step): step is string => Boolean(step));
  return [
    "This server has no AI model (OPENROUTER_API_KEY is not set), so nothing here was written or verified by a model: these are raw candidates for you to finish.",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    `${steps.length + 1}. Show the user what you propose, then call save_project_website_setup with name, domain, overview, competitors, suggestedTopics and suggestedKeywords. Saved values are never overwritten; change them later with update_project_context.`,
    ...(failedQueries.length
      ? [`Live search failed for: ${failedQueries.join(", ")}.`]
      : []),
  ].join("\n");
}

/**
 * Website research on a self-hosted server without an AI model. It returns
 * the raw material instead of drafts: the website pages read (the overview,
 * when missing, is a raw excerpt of the homepage), live Google results for
 * the project's first tracked keywords near its tracked city (organic, local
 * pack, People Also Ask, related searches), and Google's keyword candidates.
 * Competitors and topics stay empty, and guidance tells the user's own AI
 * agent how to finish and save with save_project_website_setup.
 */
export async function researchWebsiteWithoutModel(input: {
  project: { id: string; locationCode: number; languageCode: string };
  /** What research keeps from the project: name, domain, saved overview. */
  preserved: {
    name: string;
    domain: string;
    overview: string | undefined;
    preserveCompetitors: boolean;
  };
  pages: Array<{ url: string; title: string | null; text: string }>;
  missingTopics: boolean;
  organizationId: string;
}): Promise<WebsiteResearch> {
  const { project, preserved } = input;
  const { domain } = preserved;
  const missing: Missing = {
    overview: preserved.overview === undefined,
    competitors: !preserved.preserveCompetitors,
    keywords: input.missingTopics,
  };
  const brand = { name: preserved.name, domain };
  const nearby = await projectSearchTracker(project);
  const tracked = nearby.trackerId
    ? (await RankTrackingRepository.getKeywordsForConfig(nearby.trackerId))
        .map((row) => row.keyword)
        .filter((keyword) => !isBrandSearch(keyword, brand))
    : [];
  const brightData =
    missing.competitors || missing.keywords ? await getBrightDataSerp() : null;
  const queries = brightData ? tracked.slice(0, MAX_SEARCHES) : [];
  const settled = brightData
    ? await Promise.allSettled(
        queries.map((query) =>
          searchGoogleCandidates(brightData, {
            query,
            market: nearby.market,
            organizationId: input.organizationId,
          }),
        ),
      )
    : [];
  const searches = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const keywordSchema = websiteResearchSchema.shape.suggestedKeywords.element;
  const suggestedKeywords = missing.keywords
    ? [
        ...new Map(
          [...tracked, ...searches.flatMap((search) => search.relatedSearches)]
            .filter((keyword) => keywordSchema.safeParse(keyword).success)
            .map((keyword) => [normalizeAiSuggestion(keyword), keyword.trim()]),
        ).values(),
      ].slice(0, MAX_SUGGESTED_KEYWORDS)
    : [];
  const [home] = input.pages;
  return websiteResearchSchema.parse({
    name: preserved.name,
    domain,
    overview:
      preserved.overview ??
      [home?.title, home?.text]
        .filter(Boolean)
        .join(". ")
        .slice(0, OVERVIEW_EXCERPT_CHARS)
        .trim(),
    competitors: [],
    preserveCompetitors: !missing.competitors,
    suggestedTopics: [],
    suggestedKeywords,
    withoutModel: {
      missing,
      guidance: guidanceFor(
        missing,
        searches.length > 0,
        queries.filter((_, index) => settled[index]?.status === "rejected"),
      ),
      sitePages: input.pages.map(({ url, title, text }) => ({
        url,
        title,
        text: text.slice(0, PAGE_TEXT_CHARS),
      })),
      searches,
    },
  });
}
