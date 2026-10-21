import { z } from "zod";
import type { SerpSections } from "@/server/lib/brightDataSerpSections";
import { truncatePreview } from "@/server/mcp/formatters";
import {
  formatMcpTable,
  truncatedCell,
  type McpTableColumn,
} from "@/server/mcp/table";

// get_serp_results rows for the sections of a Bright Data results page besides
// organic results and the local pack, typed with DataForSEO's item names so
// either provider reads alike. rank counts within the row's section.
export const serpSectionRowSchema = z.object({
  type: z.string(),
  rank: z.number(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  domain: z.string().nullable(),
  description: z.string().nullable(),
  placement: z.enum(["top", "bottom"]).optional(),
});

type SerpSectionRow = z.infer<typeof serpSectionRowSchema>;

function ranked(
  type: string,
  rows: Array<Omit<SerpSectionRow, "type" | "rank">>,
): SerpSectionRow[] {
  return rows.map((row, index) => ({ type, rank: index + 1, ...row }));
}

export function serpSectionRows(sections: SerpSections): SerpSectionRow[] {
  const { aiOverview, knowledgeGraph } = sections;
  return [
    ...ranked("featured_snippet", sections.featuredSnippets),
    ...ranked(
      "people_also_ask",
      sections.peopleAlsoAsk.map(({ question, answer, url, domain }) => ({
        title: question,
        description: answer,
        url,
        domain,
      })),
    ),
    ...(aiOverview
      ? [
          ...ranked("ai_overview", [
            {
              title: null,
              url: null,
              domain: null,
              description: aiOverview.text,
            },
          ]),
          ...ranked(
            "ai_overview_reference",
            aiOverview.references.map((reference) => ({
              ...reference,
              description: null,
            })),
          ),
        ]
      : []),
    ...ranked("knowledge_graph", knowledgeGraph ? [knowledgeGraph] : []),
    ...ranked("paid", sections.ads),
    ...ranked(
      "related_searches",
      sections.relatedSearches.map((query) => ({
        title: query,
        url: null,
        domain: null,
        description: null,
      })),
    ),
  ];
}

export function hasAiOverview(rows: SerpSectionRow[]): boolean {
  return rows.some((row) => row.type === "ai_overview");
}

export const AI_OVERVIEW_NOT_DETECTED_NOTE =
  "AI Overview not detected means the returned page had none. These requests do not wait for an AI Overview that Google loads after the page, so Google may still show one for that query.";

const rank: McpTableColumn<SerpSectionRow> = {
  header: "rank",
  value: (row) => row.rank,
};
const domain: McpTableColumn<SerpSectionRow> = {
  header: "domain",
  value: (row) => row.domain,
};
const title: McpTableColumn<SerpSectionRow> = {
  header: "title",
  value: (row) => row.title,
};

const SECTION_TABLES: Array<{
  type: string;
  label: string;
  columns: McpTableColumn<SerpSectionRow>[];
}> = [
  {
    type: "featured_snippet",
    label: "Featured snippet",
    columns: [
      rank,
      domain,
      title,
      {
        header: "text",
        value: (row) => row.description,
        format: truncatedCell(200),
      },
    ],
  },
  {
    type: "people_also_ask",
    label: "People also ask",
    columns: [rank, { header: "question", value: (row) => row.title }, domain],
  },
  {
    type: "ai_overview_reference",
    label: "AI Overview sources",
    columns: [rank, domain, title],
  },
  {
    type: "knowledge_graph",
    label: "Knowledge panel",
    columns: [
      title,
      { header: "description", value: (row) => row.description },
      { header: "url", value: (row) => row.url },
    ],
  },
  {
    type: "paid",
    label: "Ads",
    columns: [
      rank,
      { header: "placement", value: (row) => row.placement },
      domain,
      title,
    ],
  },
  {
    type: "related_searches",
    label: "Related searches",
    columns: [rank, { header: "query", value: (row) => row.title }],
  },
];

/** Text blocks for one keyword's section rows, AI Overview first. */
export function formatSerpSectionRows(rows: SerpSectionRow[]): string[] {
  const aiOverview = rows.find((row) => row.type === "ai_overview");
  let aiLine = "AI Overview: not detected.";
  if (aiOverview) {
    aiLine = aiOverview.description
      ? `AI Overview:\n${truncatePreview(aiOverview.description, 600)}`
      : "AI Overview: shown, without its text on the returned page.";
  }
  return [
    aiLine,
    ...SECTION_TABLES.flatMap(({ type, label, columns }) => {
      const section = rows.filter((row) => row.type === type);
      return section.length > 0
        ? [`${label}:\n${formatMcpTable(section, columns)}`]
        : [];
    }),
  ];
}
