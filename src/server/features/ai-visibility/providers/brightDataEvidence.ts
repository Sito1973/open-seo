import { serpSectionsShape } from "@/server/lib/brightDataSerpSections";
import {
  citationsFrom,
  markdownToText,
  type ParsedAiAnswer,
} from "./dataforseoEvidence";

// Bright Data's parsed Google AI Overview, read with the same schema as
// get_serp_results: text blocks, each a paragraph snippet and its list items,
// and the pages it cites. A section whose shape changed reads as no overview.
const overviewSchema = serpSectionsShape.ai_overview;

/** Saved on the answer, so it never reads as an answer that left a brand out. */
const WITHOUT_TEXT_NOTE =
  "Google showed an AI Overview on this page, but Bright Data returned it without its text, so this collection counts as no answer, not as a missing brand.";

/**
 * Normalize the AI Overview of one Bright Data results page. No URL fetches
 * or model calls: all evidence comes from the captured page. A page without
 * an AI Overview is a no-answer result, as with DataForSEO. One shown without
 * its text is a no-answer result too, keeping its cited pages, with a note
 * saying why. Citations keep Google's order; there is no placement.
 */
export function parseBrightDataAiOverview(raw: unknown): ParsedAiAnswer {
  const overview = overviewSchema.parse(raw);
  const markdown = (overview?.texts ?? [])
    .map((block) =>
      [
        block.snippet?.trim(),
        (block.list ?? [])
          .flatMap((item) =>
            item.snippet?.trim() ? [`- ${item.snippet.trim()}`] : [],
          )
          .join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
    .filter(Boolean)
    .join("\n\n");
  const text = markdownToText(markdown);
  const answerText = text.trim() ? text : "";
  return {
    answerMarkdown: answerText ? markdown : null,
    answerText,
    citations: citationsFrom(
      (overview?.references ?? []).map((reference) => ({
        url: reference.href,
        title: reference.title,
      })),
    ),
    collectedAt: null,
    ...(overview && !answerText ? { note: WITHOUT_TEXT_NOTE } : {}),
  };
}
