import { Plus } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/client/components/ui/field";
import { Textarea } from "@/client/components/ui/textarea";
import { DomainFavicon } from "@/client/features/ai-visibility/DomainFavicon";
import { PROSE_MAX_CHARS } from "@/types/schemas/projectContext";
import {
  websiteResearchSchema,
  type WebsiteResearch,
} from "@/types/schemas/projectWebsite";

// What website setup shows on a self-hosted server without an AI model: the
// raw candidates research returned, for the user to pick from and edit.

type Candidates = NonNullable<WebsiteResearch["withoutModel"]>;

export function NoModelNotice() {
  return (
    <Alert>
      <AlertTitle>This server has no AI model</AlertTitle>
      <AlertDescription>
        OpenSEO can’t write your overview, check competitors, or suggest topics
        here, so below is what it found on your website and on Google for the
        keywords you track. Pick and edit what fits. Or ask your AI assistant,
        connected to OpenSEO over MCP, to finish project setup: it reads the
        same results and saves them for you.
      </AlertDescription>
    </Alert>
  );
}

export function OverviewDraftField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor="setup-overview">Business overview</FieldLabel>
      <Textarea
        id="setup-overview"
        value={value}
        maxLength={PROSE_MAX_CHARS}
        onChange={(event) => onChange(event.target.value)}
        required
      />
      <FieldDescription>
        Copied from your homepage. Rewrite it in two or three sentences: what
        you sell, and to whom.
      </FieldDescription>
    </Field>
  );
}

type CompetitorCandidate = { name: string; domain: string; detail: string };

/** Google's businesses and sites, one per domain, local pack first. */
function competitorCandidates(candidates: Candidates, ownDomain: string) {
  const rows = new Map<string, CompetitorCandidate>();
  const add = (row: CompetitorCandidate) => {
    if (row.domain !== ownDomain && !rows.has(row.domain))
      rows.set(row.domain, row);
  };
  for (const search of candidates.searches)
    for (const item of search.localPack)
      if (item.domain)
        add({
          name: item.name ?? item.domain,
          domain: item.domain,
          detail:
            item.rating == null
              ? "Map results"
              : `Map results · ${item.rating}★ (${item.reviewsCount ?? 0} reviews)`,
        });
  for (const search of candidates.searches)
    search.organic.forEach((item, index) => {
      if (item.domain)
        add({
          name: item.title ?? item.domain,
          domain: item.domain,
          detail: `#${index + 1} for “${search.query}”`,
        });
    });
  return [...rows.values()];
}

export function CompetitorCandidates({
  candidates,
  ownDomain,
  added,
  onAdd,
}: {
  candidates: Candidates;
  ownDomain: string;
  added: Set<string>;
  onAdd: (competitor: { name: string; domain: string }) => void;
}) {
  const rows = competitorCandidates(candidates, ownDomain);
  if (!rows.length)
    return (
      <p className="text-sm text-muted-foreground">
        No Google results to pick from. OpenSEO searches the first keywords this
        project tracks in Rank Tracking, through Bright Data. Add competitors by
        hand, or track a few keywords and run setup again.
      </p>
    );
  const near = candidates.searches.find(
    (search) => search.locationName,
  )?.locationName;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        On Google for{" "}
        {candidates.searches.map((search) => `“${search.query}”`).join(", ")}
        {near ? ` near ${near}` : ""}
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {rows.map((row) => (
          <li key={row.domain} className="flex items-center gap-3 px-3 py-2">
            <DomainFavicon domain={row.domain} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{row.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {row.domain} · {row.detail}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={added.has(row.domain)}
              onClick={() =>
                onAdd({ name: row.name.slice(0, 120), domain: row.domain })
              }
            >
              <Plus className="size-4" /> Add
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One keyword per line; null unless every line is a valid research keyword. */
export function parseKeywordLines(text: string): string[] | null {
  const keywords = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const valid =
    keywords.length > 0 &&
    websiteResearchSchema.shape.suggestedKeywords.safeParse(keywords).success;
  return valid ? keywords : null;
}

export function KeywordCandidatesField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const invalid = value.trim() !== "" && parseKeywordLines(value) === null;
  return (
    <Field>
      <FieldLabel htmlFor="setup-keywords">Prompt Research keywords</FieldLabel>
      <Textarea
        id="setup-keywords"
        value={value}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription>
        One per line, up to 15, five words or fewer each. Filled in from the
        keywords you track and Google’s related searches; keep the ones that
        describe what you sell.
      </FieldDescription>
    </Field>
  );
}
