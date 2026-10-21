import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { formatCount } from "@/client/features/ai-search/platformLabels";
import { getGa4AiAssistantVisits } from "@/serverFunctions/ga4";

/** Sessions AI assistants sent to the project's site, from Google Analytics. */
export function AiAssistantVisitsCard({ projectId }: { projectId: string }) {
  const visitsQuery = useQuery({
    queryKey: ["brandLookupAiAssistantVisits", projectId],
    queryFn: () => getGa4AiAssistantVisits({ data: { projectId } }),
    // The server keeps the report for a day.
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const visits = visitsQuery.data;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium">Visits from AI assistants</h3>
        <p className="text-xs text-muted-foreground">
          Google Analytics · Last 28 days
          {visits?.connected ? ` · ${visits.propertyDisplayName}` : null}
        </p>
      </div>
      <div className="space-y-2 p-4 text-sm">
        {visitsQuery.isError ? (
          <p className="text-muted-foreground">
            Couldn&rsquo;t load Google Analytics data. Try again shortly.
          </p>
        ) : !visits ? (
          <Skeleton className="h-16" />
        ) : !visits.connected ? (
          <p className="text-muted-foreground">
            Connect Google Analytics in{" "}
            <Link
              to="/p/$projectId/settings"
              params={{ projectId }}
              hash="google-analytics"
              className="underline"
            >
              Settings
            </Link>{" "}
            to see the visits ChatGPT, Perplexity, Gemini, Claude and Copilot
            send to this site.
          </p>
        ) : visits.sessions === 0 ? (
          <p className="text-muted-foreground">
            No sessions from AI assistants between {visits.startDate} and{" "}
            {visits.endDate}.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Key events</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="font-medium">
                <TableCell>Total</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(visits.sessions)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(visits.keyEvents)}
                </TableCell>
              </TableRow>
              {visits.sources.map((row) => (
                <TableRow key={row.source}>
                  <TableCell className="break-all">{row.source}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(row.sessions)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(row.keyEvents)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {visits?.connected ? (
          <p className="text-xs text-muted-foreground">
            Sessions in GA4&rsquo;s AI Assistant channel or from a source that
            names an AI assistant.
            {visits.hasLimitedData
              ? " Google Analytics sampled or thresholded this report."
              : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
