import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import {
  getGoogleAccountRemovalImpact,
  removeGoogleAccount,
} from "@/serverFunctions/googleAccounts";
import type { GoogleLinkProvider } from "@/shared/google-link";

/** Queries showing a provider's connection, refetched after a removal. */
const REMOVAL_QUERY_KEYS: Record<GoogleLinkProvider, string[]> = {
  gsc: [
    "gscConnection",
    "gscSites",
    "gscGrantStatus",
    "searchPerformance",
    "searchPerformanceTable",
    "dashboardGscReport",
    "dashboardActivation",
  ],
  ga4: [
    "ga4Connection",
    "ga4Properties",
    "dashboardGa4Report",
    "dashboardActivation",
  ],
  gbp: ["gbpConnection", "gbpAccounts"],
};

const PROVIDER_NAMES: Record<GoogleLinkProvider, string> = {
  gsc: "Search Console",
  ga4: "Google Analytics",
  gbp: "Business Profile",
};

export function GoogleAccountRemovalDialog({
  provider,
  accountId,
  label,
  onClose,
  onRemoved,
}: {
  provider: GoogleLinkProvider;
  accountId: string;
  label: string;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const queryClient = useQueryClient();
  const impact = useQuery({
    queryKey: ["googleAccountRemovalImpact", provider, accountId],
    queryFn: () =>
      getGoogleAccountRemovalImpact({ data: { provider, accountId } }),
    staleTime: 0,
    gcTime: 0,
  });
  const removal = useMutation({
    meta: { errorToast: false },
    mutationFn: () =>
      removeGoogleAccount({ data: { provider, accountId, confirmed: true } }),
    onSuccess: async () => {
      await Promise.all(
        REMOVAL_QUERY_KEYS[provider].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
      toast.success("Google account removed");
      onRemoved();
    },
  });
  const name = PROVIDER_NAMES[provider];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !removal.isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Remove Google account?</DialogTitle>
          <DialogDescription>
            This removes the account’s {name} connection from OpenSEO. You can
            reconnect it anytime.
          </DialogDescription>
        </DialogHeader>
        <p className="break-all text-sm font-medium">{label}</p>
        {impact.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking connected projects…
          </p>
        ) : impact.isError ? (
          <div role="alert" className="text-sm">
            <p className="text-destructive">
              Couldn't check connected projects.
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void impact.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : impact.data.projectCount > 0 ? (
          <p className="text-sm font-medium">
            This will also disconnect {name} from {impact.data.projectCount}{" "}
            project{impact.data.projectCount === 1 ? "" : "s"}.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No projects will be affected.
          </p>
        )}
        {removal.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {getStandardErrorMessage(removal.error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            disabled={removal.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={
              !impact.isSuccess || impact.isFetching || removal.isPending
            }
            onClick={() => removal.mutate()}
          >
            {removal.isPending ? "Removing…" : "Remove account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
