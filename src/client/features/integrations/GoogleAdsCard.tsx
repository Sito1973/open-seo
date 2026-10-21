import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CardShell } from "@/client/components/CardShell";
import { QueryError } from "@/client/components/QueryState";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import { GoogleGlyph } from "@/client/features/gsc/GoogleGlyph";
import { GoogleLinkErrorAlert } from "@/client/features/integrations/GoogleLinkErrorAlert";
import { GoogleOAuthSetupWarning } from "@/client/features/integrations/GoogleOAuthSetupWarning";
import {
  startGoogleLink,
  useGoogleLinkPending,
} from "@/client/features/integrations/startGoogleLink";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  disconnectGoogleAds,
  getGoogleAdsConnection,
} from "@/serverFunctions/googleAds";
import { GOOGLE_ADS_SETUP_DOCS_URL } from "@/shared/google-ads";

const CONNECTION_KEY = ["googleAdsConnection"];

/**
 * Self-hosted only: the signed-in user's Google Ads grant, which the Keyword
 * Planner uses for keyword volumes and ideas when DataForSEO is not set up.
 * The grant belongs to the user, not to this project.
 */
export function GoogleAdsCard() {
  const queryClient = useQueryClient();
  const linking = useGoogleLinkPending();
  const statusQuery = useQuery({
    queryKey: CONNECTION_KEY,
    queryFn: () => getGoogleAdsConnection(),
  });
  const disconnectMutation = useMutation({
    meta: { errorToast: false },
    mutationFn: () => disconnectGoogleAds(),
    onSuccess: () => {
      toast.success("Google Ads disconnected");
      void queryClient.invalidateQueries({ queryKey: CONNECTION_KEY });
    },
  });
  const status = statusQuery.data;
  const ready = status?.plannerActive && status.oauthConfigured;

  return (
    <CardShell
      title="Google Ads Keyword Planner"
      icon={<GoogleGlyph className="size-5" />}
      action={
        status ? (
          <Badge
            variant={
              ready ? (status.connected ? "success" : "outline") : "warning"
            }
          >
            <span className="size-1.5 rounded-full bg-current" />
            {ready
              ? status.connected
                ? "Connected"
                : "Not connected"
              : "Setup required"}
          </Badge>
        ) : undefined
      }
    >
      <GoogleLinkErrorAlert provider="ads" className="mb-4" />
      {statusQuery.isPending ? (
        <div
          role="status"
          aria-label="Loading connection"
          className="space-y-3"
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-9 w-24" />
        </div>
      ) : statusQuery.isError ? (
        <QueryError
          error={statusQuery.error}
          fallback="Couldn't check the Google Ads connection."
          onRetry={() => void statusQuery.refetch()}
          isRetrying={statusQuery.isFetching}
        />
      ) : !status?.plannerActive ? (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Without a DataForSEO key, keyword volumes and ideas can come from
            your Google Ads account&apos;s Keyword Planner. Set
            GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and
            GOOGLE_ADS_CUSTOMER_ID on this server to use it.
          </p>
          <SafeExternalLink
            url={GOOGLE_ADS_SETUP_DOCS_URL}
            label="Open setup guide"
            className="font-medium underline underline-offset-2"
          />
        </div>
      ) : !status.oauthConfigured ? (
        <GoogleOAuthSetupWarning
          integrationName="Google Ads"
          docsUrl={GOOGLE_ADS_SETUP_DOCS_URL}
        />
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {status.connected
              ? "Keyword research reads search volumes and ideas from your Google Ads account's Keyword Planner. OpenSEO only reads keyword data and never changes campaigns."
              : "Connect the Google account that can open your Google Ads account. Keyword research then reads search volumes and ideas from its Keyword Planner."}
          </p>
          <div className="mt-auto flex flex-wrap items-center justify-end gap-2">
            {status.connected ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => disconnectMutation.mutate()}
                pending={disconnectMutation.isPending}
                disabled={linking}
              >
                Disconnect
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void startGoogleLink("ads", window.location.href)}
              pending={linking}
              disabled={disconnectMutation.isPending}
            >
              {linking ? null : <GoogleGlyph className="size-[18px]" />}
              {linking
                ? "Opening Google…"
                : status.connected
                  ? "Reconnect"
                  : "Connect"}
            </Button>
          </div>
        </div>
      )}
      {disconnectMutation.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {getStandardErrorMessage(disconnectMutation.error)}
        </p>
      ) : null}
    </CardShell>
  );
}
