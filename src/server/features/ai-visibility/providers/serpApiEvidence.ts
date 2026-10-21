import { z } from "zod";
import {
  citationsFrom,
  citationUrl,
  markdownToText,
  type AiCitation,
  type ParsedAiAnswer,
} from "./dataforseoEvidence";

// SerpApi's Google AI Mode response. The answer is a list of text blocks
// (paragraphs, headings, lists, tables, expandable sections). A block or list
// item names the references it links in its text in reference_indexes, and
// `references` lists every cited page in Google's order.
// https://serpapi.com/google-ai-mode-api

interface SerpApiBlock {
  type?: string;
  title?: string;
  snippet?: string;
  reference_indexes?: number[];
  /** A business in a list item; its name is part of the answer. */
  local_result?: { title?: string };
  list?: SerpApiBlock[];
  table?: string[][];
  text_blocks?: SerpApiBlock[];
}

// An unreadable field is dropped instead of failing the whole answer.
const text = z.string().max(100_000).optional().catch(undefined);
const blockSchema: z.ZodType<SerpApiBlock> = z.lazy(() =>
  z.object({
    type: text,
    title: text,
    snippet: text,
    reference_indexes: z
      .array(z.number().int())
      .max(500)
      .optional()
      .catch(undefined),
    local_result: z.object({ title: text }).optional().catch(undefined),
    list: z.array(blockSchema).max(500).optional().catch(undefined),
    table: z
      .array(z.array(z.string().max(10_000)).max(50))
      .max(500)
      .optional()
      .catch(undefined),
    text_blocks: z.array(blockSchema).max(500).optional().catch(undefined),
  }),
);
const answerSchema = z.object({
  text_blocks: z.array(blockSchema).max(500).nullish(),
  references: z.array(z.unknown()).max(2_000).nullish(),
});
const referenceSchema = z.object({
  index: z.number().int(),
  link: z.string().max(16_384),
  title: z.string().max(10_000).nullish(),
});

/** Citation chips for a block's reference indexes. */
type Chips = (indexes?: number[]) => string;

/**
 * Normalize one SerpApi Google AI Mode answer. No URL fetches or model calls:
 * all evidence comes from the captured result. Returns null for an unreadable
 * result. Citations keep the references' order. A cited page is "inline" when
 * the answer text links it, ranked by its first link, else "reference". An
 * answer whose text links no cited page records no placement, so a format
 * change can never mark every page as listed only.
 */
export function parseSerpApiAiModeAnswer(raw: unknown): ParsedAiAnswer | null {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const references = (parsed.data.references ?? []).flatMap((item) => {
    const reference = referenceSchema.safeParse(item);
    return reference.success ? [reference.data] : [];
  });
  const citations = citationsFrom(
    references.map(({ link, title }) => ({ url: link, title })),
  );
  const byIndex = new Map<number, AiCitation>();
  for (const reference of references) {
    const url = citationUrl(reference.link)?.toString();
    const citation = citations.find((c) => c.url === url);
    if (citation) byIndex.set(reference.index, citation);
  }
  // Cited URLs in the order the answer text first links them.
  const inline: string[] = [];
  const chips: Chips = (indexes = []) =>
    [...new Set(indexes.flatMap((index) => byIndex.get(index) ?? []))]
      .map((citation) => {
        if (!inline.includes(citation.url)) inline.push(citation.url);
        // Chips numbered by first link, like each source's inlineOrder.
        // markdownToText drops them, as it drops AI Overview's.
        const href = citation.url.replaceAll("(", "%28").replaceAll(")", "%29");
        return ` [[${inline.indexOf(citation.url) + 1}]](${href})`;
      })
      .join("");
  const markdown = (parsed.data.text_blocks ?? [])
    .map((block) => blockMarkdown(block, chips))
    .filter(Boolean)
    .join("\n\n");
  const answerText = markdownToText(markdown);
  return {
    answerMarkdown: answerText.trim() ? markdown : null,
    answerText: answerText.trim() ? answerText : "",
    citations: inline.length
      ? citations.map((citation) => {
          const order = inline.indexOf(citation.url) + 1;
          return {
            ...citation,
            placement: order ? "inline" : "reference",
            inlineOrder: order || null,
          };
        })
      : citations,
    collectedAt: null,
  };
}

/** One block as markdown, in reading order so chips number first links. */
function blockMarkdown(block: SerpApiBlock, chips: Chips): string {
  const line = blockLine(block, chips);
  return [
    line && (block.type === "heading" ? `### ${line}` : line),
    block.list && listMarkdown(block.list, chips, ""),
    block.table?.length && tableMarkdown(block.table),
    ...(block.text_blocks ?? []).map((child) => blockMarkdown(child, chips)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A block's title and text, then its citation chips. */
function blockLine(block: SerpApiBlock, chips: Chips): string {
  const title = block.title ?? block.local_result?.title;
  const line = [title && `**${title}**`, block.snippet]
    .filter(Boolean)
    .join(": ");
  return `${line}${chips(block.reference_indexes)}`.trim();
}

function listMarkdown(
  items: SerpApiBlock[],
  chips: Chips,
  indent: string,
): string {
  return items
    .map((item) =>
      [
        `${indent}- ${blockLine(item, chips)}`,
        item.list && listMarkdown(item.list, chips, `${indent}  `),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

/** A GFM table; the first row is the header. */
function tableMarkdown(rows: string[][]): string {
  return [
    tableRow(rows[0]),
    tableRow(rows[0].map(() => "---")),
    ...rows.slice(1).map(tableRow),
  ].join("\n");
}

function tableRow(cells: string[]): string {
  return `| ${cells.map((cell) => cell.replace(/\s+/g, " ").replaceAll("|", "\\|")).join(" | ")} |`;
}
