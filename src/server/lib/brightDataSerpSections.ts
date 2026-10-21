import { z } from "zod";
import { safeHostname } from "@/shared/safe-url";

// The sections of Bright Data's parsed Google page besides organic results and
// the local pack, with the field names its parsed JSON documents. Each section
// is optional and becomes undefined when its shape changes, so a new Google
// layout drops that section, never the whole page.
const optionalText = z.string().optional().catch(undefined);

function optionalList<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.array(z.object(shape)).optional().catch(undefined);
}

const adShape = {
  title: optionalText,
  link: optionalText,
  description: optionalText,
};

export const serpSectionsShape = {
  featured_snippets: optionalList({
    title: optionalText,
    description: optionalText,
    value: optionalText,
    link: optionalText,
    // A list snippet keeps its text in items.
    items: optionalList({ text: optionalText }),
  }),
  people_also_ask: optionalList({
    question: optionalText,
    answer: optionalText,
    link: optionalText,
  }),
  related: optionalList({
    text: optionalText,
    // An expanded entry nests more searches.
    items: optionalList({ text: optionalText }),
  }),
  top_ads: optionalList(adShape),
  bottom_ads: optionalList(adShape),
  ai_overview: z
    .object({
      texts: optionalList({
        snippet: optionalText,
        list: optionalList({ snippet: optionalText }),
      }),
      references: optionalList({
        href: optionalText,
        title: optionalText,
      }),
    })
    .optional()
    .catch(undefined),
  knowledge: z
    .object({
      title: optionalText,
      subtitle: optionalText,
      type: optionalText,
      description: optionalText,
      link: optionalText,
    })
    .optional()
    .catch(undefined),
};

type SerpSectionsPage = z.infer<z.ZodObject<typeof serpSectionsShape>>;

/** A result link's hostname without www, or null for a missing or bad link. */
export function domainOf(link: string | null | undefined): string | null {
  return safeHostname(link);
}

type AdItem = NonNullable<SerpSectionsPage["top_ads"]>[number];

function linked(link: string | undefined) {
  return { url: link ?? null, domain: domainOf(link) };
}

function nonEmpty(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value?.trim()));
}

function readAd(placement: "top" | "bottom") {
  return (ad: AdItem) => ({
    placement,
    title: ad.title ?? null,
    ...linked(ad.link),
    description: ad.description ?? null,
  });
}

/**
 * The page's other sections in OpenSEO's shape. aiOverview is null when the
 * page has none; its text is null when the page shows one without its text.
 */
export function readSerpSections(page: SerpSectionsPage) {
  const { ai_overview: aiOverview, knowledge } = page;
  return {
    featuredSnippets: (page.featured_snippets ?? []).map((snippet) => ({
      title: snippet.title ?? null,
      ...linked(snippet.link),
      description:
        snippet.description ??
        snippet.value ??
        (nonEmpty(snippet.items?.map((item) => item.text) ?? []).join("; ") ||
          null),
    })),
    peopleAlsoAsk: (page.people_also_ask ?? []).flatMap((item) =>
      item.question
        ? [
            {
              question: item.question,
              answer: item.answer ?? null,
              ...linked(item.link),
            },
          ]
        : [],
    ),
    relatedSearches: [
      ...new Set(
        nonEmpty(
          (page.related ?? []).flatMap((item) => [
            item.text,
            ...(item.items ?? []).map((nested) => nested.text),
          ]),
        ),
      ),
    ],
    ads: [
      ...(page.top_ads ?? []).map(readAd("top")),
      ...(page.bottom_ads ?? []).map(readAd("bottom")),
    ],
    aiOverview: aiOverview
      ? {
          text:
            nonEmpty(
              (aiOverview.texts ?? []).flatMap((block) => [
                block.snippet,
                ...(block.list ?? []).map((entry) => entry.snippet),
              ]),
            ).join("\n") || null,
          references: (aiOverview.references ?? []).flatMap((reference) =>
            reference.href
              ? [{ title: reference.title ?? null, ...linked(reference.href) }]
              : [],
          ),
        }
      : null,
    knowledgeGraph: knowledge?.title
      ? {
          title: knowledge.title,
          ...linked(knowledge.link),
          description:
            knowledge.description ??
            knowledge.subtitle ??
            knowledge.type ??
            null,
        }
      : null,
  };
}

export type SerpSections = ReturnType<typeof readSerpSections>;
