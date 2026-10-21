import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RowSelectionState } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import {
  TableBulkActionBar,
  TableBulkActionButton,
} from "@/client/components/table/TableBulkActionBar";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import { Field, FieldLabel } from "@/client/components/ui/field";
import { Textarea } from "@/client/components/ui/textarea";
import { researchAiVisibilityPrompts } from "@/serverFunctions/ai-visibility";
import { normalizeAiSuggestion } from "@/shared/ai-prompt-suggestions";
import type { AiTrackerState } from "@/shared/ai-visibility";
import { PromptResearchTable } from "./PromptResearchTable";
import { TopicField } from "./TopicField";
import { TrackerPatchReview } from "./TrackerPatchReview";
import { AiQueryError, aiVisibilityKey } from "./shared";

export function PromptResearchKeyword({
  projectId,
  state,
  keyword,
}: {
  projectId: string;
  state: AiTrackerState;
  keyword: string;
}) {
  const queryClient = useQueryClient();
  const promptFieldId = useId();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  // The prompts to track and their topic, while the user reviews them. Each
  // keeps the researched text it started from, as its key.
  const [change, setChange] = useState<{
    prompts: { from: string; text: string }[];
    topic: string;
  } | null>(null);
  // The tracked prompts refresh tracked flags after any tracker edit. The
  // server reuses its cached provider response, so this costs no extra credits.
  const research = useQuery({
    queryKey: [
      ...aiVisibilityKey(projectId),
      "research",
      keyword,
      state.prompts.filter((prompt) => !prompt.archived).map(({ id }) => id),
    ],
    queryFn: () =>
      researchAiVisibilityPrompts({ data: { projectId, keyword } }),
    retry: false,
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  // Google's raw candidates, on a server without DataForSEO: reworded
  // before they are tracked.
  const candidates = research.data?.withoutModel;
  // Table order, so the review lists prompts as the user sees them.
  const selected = (research.data?.prompts ?? [])
    .filter((prompt) => rowSelection[prompt.text])
    .map((prompt) => prompt.text);
  // Defaults to the saved topic that matches the keyword, else the keyword.
  const track = () =>
    setChange({
      prompts: selected.map((text) => ({ from: text, text })),
      topic:
        state.topics.find(
          (name) =>
            normalizeAiSuggestion(name) === normalizeAiSuggestion(keyword),
        ) ?? keyword,
    });
  const topic = change?.topic.trim();
  const texts = change?.prompts.map((prompt) => prompt.text.trim()) ?? [];
  return (
    <>
      {candidates && (
        <Alert>
          <AlertTitle>Google’s candidates, not AI prompts</AlertTitle>
          <AlertDescription>
            <p>
              This server has no AI prompt database or AI model, so these come
              from Google: People Also Ask questions and related searches for “
              {keyword}”, autocomplete, your site’s Search Console questions and
              your Business Profile searches, ranked by their labeled searches.
              None of them counts how often people ask an AI. Reword the ones
              you pick as a customer would ask an AI assistant before tracking
              them, or ask your AI assistant, connected to OpenSEO over MCP, to
              rewrite and save them.
            </p>
            {candidates.notes.length > 0 && (
              <ul className="list-disc pl-5">
                {candidates.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}
      <TableBulkActionBar
        selectedCount={selected.length}
        onClear={() => setRowSelection({})}
        actions={
          <div className="flex items-center px-1.5">
            <TableBulkActionButton
              icon={<Plus className="size-3.5" />}
              onClick={track}
            >
              Track prompts
            </TableBulkActionButton>
          </div>
        }
      />
      <PromptResearchTable
        prompts={research.data?.prompts ?? []}
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        isLoading={research.isPending}
        error={
          research.isError ? (
            <AiQueryError
              error={research.error}
              retry={() => {
                void research.refetch();
              }}
            />
          ) : undefined
        }
        empty={{
          title: `No prompts found for “${keyword}”`,
          description: candidates
            ? "Google showed nothing about this keyword. Try a shorter, broader term."
            : "Try a shorter, broader term.",
        }}
        toolbar={
          <div className="border-b px-4 py-3 border-border">
            <h2 className="font-medium">Prompts about “{keyword}”</h2>
          </div>
        }
      />
      {change && (
        <TrackerPatchReview
          projectId={projectId}
          state={state}
          patch={{
            prompts: texts.filter(Boolean).map((text) => ({
              text,
              topic: topic || undefined,
            })),
          }}
          canSave={Boolean(topic) && texts.every(Boolean)}
          showPrompts={!candidates}
          onClose={() => setChange(null)}
          onSaved={(next) => {
            queryClient.setQueryData(
              [...aiVisibilityKey(projectId), "tracker"],
              next,
            );
            setChange(null);
            setRowSelection({});
          }}
        >
          <TopicField
            topics={state.topics}
            value={change.topic}
            onChange={(name) => setChange({ ...change, topic: name })}
          />
          {candidates &&
            change.prompts.map((prompt, index) => (
              <Field key={prompt.from}>
                <FieldLabel htmlFor={`${promptFieldId}-${index}`}>
                  Prompt {index + 1}, from “{prompt.from}”
                </FieldLabel>
                <Textarea
                  id={`${promptFieldId}-${index}`}
                  value={prompt.text}
                  maxLength={2000}
                  onChange={(event) =>
                    setChange({
                      ...change,
                      prompts: change.prompts.map((item) =>
                        item.from === prompt.from
                          ? { ...item, text: event.target.value }
                          : item,
                      ),
                    })
                  }
                  data-ph-mask
                />
              </Field>
            ))}
        </TrackerPatchReview>
      )}
    </>
  );
}
