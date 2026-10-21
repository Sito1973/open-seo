import { useMemo, type ComponentProps } from "react";
import type {
  ColumnDef,
  OnChangeFn,
  RowSelectionState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import {
  DataTable,
  type DataTableFrameProps,
  makeSelectionColumn,
  useDataTable,
  useSelectionAnchor,
} from "@/client/components/table/DataTable";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  AI_ENGINE_LABELS,
  AI_PROMPT_CANDIDATE_ORIGIN_LABELS,
  AI_PROMPT_CANDIDATE_VOLUME_LABELS,
  type AiPromptCandidateAnswer,
  type AiResearchedPrompt,
} from "@/shared/ai-visibility";
import { DomainFavicon } from "./DomainFavicon";

const promptColumns: ColumnDef<AiResearchedPrompt>[] = [
  {
    id: "prompt",
    header: "Prompt",
    cell: ({ row: { original: prompt } }) => (
      <>
        <span>{prompt.text}</span>
        {prompt.tracked && (
          <Badge variant="secondary" className="ml-2">
            Tracked
          </Badge>
        )}
        {prompt.origins && (
          <p className="text-xs text-muted-foreground">
            {prompt.origins
              .filter((origin) => origin !== "tracked")
              .map((origin) => AI_PROMPT_CANDIDATE_ORIGIN_LABELS[origin])
              .join(" · ")}
          </p>
        )}
        {prompt.variants.length > 0 && (
          <p
            className="text-xs text-muted-foreground"
            title={prompt.variants.join("\n")}
          >
            +{prompt.variants.length} similar{" "}
            {prompt.variants.length === 1 ? "prompt" : "prompts"} merged
          </p>
        )}
      </>
    ),
  },
  {
    id: "volume",
    header: "Search demand",
    meta: { headerClassName: "w-44" },
    cell: ({ row: { original: prompt } }) =>
      prompt.volume ? (
        <>
          <span className="text-sm tabular-nums">
            {prompt.volume.below ? "<" : ""}
            {prompt.volume.value.toLocaleString()}
          </span>
          <p className="text-xs text-muted-foreground">
            {AI_PROMPT_CANDIDATE_VOLUME_LABELS[prompt.volume.source]}
          </p>
        </>
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
  },
  {
    id: "sources",
    header: "Sources",
    meta: { headerClassName: "w-40" },
    cell: ({ row: { original: prompt } }) => (
      <>
        <span className="text-sm">
          {prompt.sources.length
            ? `${prompt.sources.length} ${prompt.sources.length === 1 ? "source" : "sources"}`
            : "No sources"}
        </span>
        {prompt.ownDomainCited && (
          <Badge variant="success" size="sm" className="ml-2">
            You
          </Badge>
        )}
      </>
    ),
  },
  {
    id: "expand",
    header: () => <span className="sr-only">Details</span>,
    meta: { headerClassName: "w-10" },
    cell: ({ row }) => (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-expanded={row.getIsExpanded()}
        aria-label={`Show sources for ${row.original.text}`}
        onClick={() => row.toggleExpanded()}
      >
        {row.getIsExpanded() ? <ChevronDown /> : <ChevronRight />}
      </Button>
    ),
  },
];

/** Tracked prompts can't be selected; a selection only adds new prompts. */
export function PromptResearchTable({
  prompts,
  rowSelection,
  onRowSelectionChange,
  empty,
  ...frame
}: DataTableFrameProps & {
  prompts: AiResearchedPrompt[];
  rowSelection: RowSelectionState;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
  empty: ComponentProps<typeof DataTable>["empty"];
}) {
  const selectAnchorRef = useSelectionAnchor();
  // Google's candidates carry a labeled search volume; DataForSEO's do not.
  const fromGoogle = prompts.some((prompt) => prompt.origins);
  const columns = useMemo(
    () => [
      makeSelectionColumn<AiResearchedPrompt>(
        selectAnchorRef,
        (row) => `Select ${row.original.text}`,
      ),
      ...promptColumns.filter((column) => fromGoogle || column.id !== "volume"),
    ],
    [selectAnchorRef, fromGoogle],
  );
  const table = useDataTable({
    data: prompts,
    columns,
    state: { rowSelection },
    onRowSelectionChange,
    getRowId: (prompt) => prompt.text,
    enableRowSelection: (row) => !row.original.tracked,
  });
  return (
    <DataTable
      {...frame}
      table={table}
      empty={empty}
      renderExpandedRow={(row) => <PromptSources prompt={row.original} />}
    />
  );
}

function CandidateAnswer({ answer }: { answer: AiPromptCandidateAnswer }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">
        {answer.kind === "last_answer"
          ? `Last answer · ${AI_ENGINE_LABELS[answer.engine]}${answer.collectedAt ? ` · ${new Date(answer.collectedAt).toLocaleDateString()}` : ""}`
          : "Google’s People Also Ask answer, not an AI answer"}
      </p>
      <p className="text-sm whitespace-pre-wrap" data-ph-mask>
        {answer.text}
      </p>
    </div>
  );
}

function PromptSources({ prompt }: { prompt: AiResearchedPrompt }) {
  // A Google candidate has an answer only when tracked or from People Also Ask.
  if (prompt.origins && !prompt.answer)
    return (
      <p className="py-1 pl-10 text-sm text-muted-foreground">
        {prompt.tracked
          ? "Tracked. No answer has been collected yet."
          : "No answer yet. Track it to collect AI answers."}
      </p>
    );
  return (
    <div className="space-y-2 py-1 pl-10">
      {prompt.answer && <CandidateAnswer answer={prompt.answer} />}
      <Badge variant={prompt.brandMentioned ? "success" : "outline"}>
        {prompt.brandMentioned
          ? "Your brand is mentioned"
          : "Your brand is not mentioned"}
      </Badge>
      {prompt.sources.length ? (
        <ul className="space-y-1.5">
          {prompt.sources.map((source) => (
            <li key={source.url} className="flex items-center gap-2 text-sm">
              <DomainFavicon domain={source.domain} />
              <span className="w-40 shrink-0 truncate text-muted-foreground">
                {source.domain}
              </span>
              <SafeExternalLink
                url={source.url}
                label={source.title ?? source.url}
                className="inline-flex min-w-0 items-center gap-1 hover:underline"
              />
              {source.own && (
                <Badge variant="success" size="sm">
                  You
                </Badge>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {prompt.answer?.kind === "people_also_ask"
            ? "Google showed no source link."
            : "The AI answered from memory and cited no sources."}
        </p>
      )}
    </div>
  );
}
