import { PageHeader } from "@/client/components/PageHeader";
import { QueryState } from "@/client/components/QueryState";
import { Badge } from "@/client/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";
import { Progress } from "@/client/components/ui/progress";
import { helpLinkClassName } from "@/client/features/help/SecretHelpPage";
import { useDataSources } from "@/client/features/help/dataSources";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import type {
  DataBudget,
  DataSection,
  DataSourceState,
} from "@/shared/data-sources";

const GUIDE_URL =
  "https://github.com/Sito1973/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_APIS.md";

const STATE_BADGES: Record<
  DataSourceState,
  { label: string; variant: "success" | "info" | "warning" | "secondary" }
> = {
  ready: { label: "Ready", variant: "success" },
  partial: { label: "Partial", variant: "info" },
  needs_setup: { label: "Needs setup", variant: "warning" },
  unavailable: { label: "No source", variant: "secondary" },
};

export function DataSourcesPage() {
  const query = useDataSources();
  return (
    <div className="h-full overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-4xl space-y-4">
        <PageHeader
          title="Data sources"
          description={
            <>
              What serves each section of OpenSEO on this server, and how much
              of each free monthly budget is used. The{" "}
              <a
                className={helpLinkClassName}
                href={GUIDE_URL}
                target="_blank"
                rel="noreferrer"
              >
                Google APIs self-hosting guide
              </a>{" "}
              explains each source and how to set it up.
            </>
          }
        />
        {isHostedClientAuthMode() ? (
          <AllDataforseo />
        ) : (
          <QueryState
            query={query}
            errorFallback="Could not load this server's data sources."
          >
            {(status) =>
              status ? (
                <>
                  <SectionsCard sections={status.sections} />
                  <BudgetsCard budgets={status.budgets} />
                </>
              ) : (
                <AllDataforseo />
              )
            }
          </QueryState>
        )}
      </div>
    </div>
  );
}

function AllDataforseo() {
  return (
    <Card>
      <CardContent className="text-sm text-muted-foreground">
        DataForSEO serves every section on this server, so there are no stand-in
        sources or budgets to show.
      </CardContent>
    </Card>
  );
}

function SectionsCard({ sections }: { sections: DataSection[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Sections</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {sections.map((section) => {
            const badge = STATE_BADGES[section.state];
            return (
              <li key={section.id} className="space-y-1 py-3 first:pt-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-medium">{section.label}</h3>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </div>
                <p className="text-sm">{section.source}</p>
                <p className="text-sm text-muted-foreground">
                  {section.detail}
                </p>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function BudgetsCard({ budgets }: { budgets: DataBudget[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Monthly budgets</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          OpenSEO stops each provider at its monthly budget. Free-tier providers
          stop below their free allowance; a paid one stops at the cap set for
          it. A call past a budget fails until the budget resets.
        </p>
        <ul className="space-y-4">
          {budgets.map((budget) => (
            <li key={budget.label} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{budget.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {budget.used.toLocaleString("en-US")} of{" "}
                  {budget.limit.toLocaleString("en-US")}
                </span>
              </div>
              <Progress
                value={Math.min(100, (budget.used / budget.limit) * 100)}
                aria-label={`${budget.label}: ${budget.used} of ${budget.limit} used`}
              />
              <p className="text-xs text-muted-foreground">
                Resets on {budget.resets}.{budget.note ? ` ${budget.note}` : ""}
              </p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
