import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { mapGa4ReportError } from "@/server/features/ga4/services/Ga4ReportingService";
import { GoogleAccountRepository } from "@/server/features/google/GoogleAccountRepository";
import { createGa4AdminClient } from "@/server/lib/ga4Client";
import {
  Ga4AdminApiError,
  Ga4MalformedResponseError,
  Ga4ReportError,
} from "@/server/lib/ga4Errors";
import { GA4_EDIT_SCOPE } from "@/shared/ga4";

export const GA4_KEY_EVENT_COUNTING_METHODS = [
  "ONCE_PER_EVENT",
  "ONCE_PER_SESSION",
] as const;
type CountingMethod = (typeof GA4_KEY_EVENT_COUNTING_METHODS)[number];

const READ_ONLY_CONNECTION =
  "This Google Analytics connection is read-only. Reconnect Google Analytics on the integrations page and accept the permission to edit, then call again.";

/**
 * Marks one event of the project's property as a key event, or removes the
 * mark. Without `apply` it only reports what would change. Self-hosted only:
 * the write needs GA4_EDIT_SCOPE, which hosted grants never hold.
 */
async function updateKeyEvent(input: {
  projectId: string;
  eventName: string;
  remove: boolean;
  countingMethod: CountingMethod;
  apply: boolean;
}) {
  const connection = await Ga4ConnectionRepository.getByProjectId(
    input.projectId,
  );
  if (!connection) {
    throw new Ga4ReportError(
      "ga4_not_connected",
      "Google Analytics is not connected for this project.",
    );
  }
  const client = createGa4AdminClient({
    userId: connection.connectedByUserId,
    ga4AccountId: connection.ga4AccountId,
  });
  try {
    const [keyEvents, scopes] = await Promise.all([
      client.listKeyEvents(connection.propertyId),
      GoogleAccountRepository.getGrantedScopes({
        userId: connection.connectedByUserId,
        provider: "ga4",
        accountId: connection.ga4AccountId,
      }),
    ]);
    const existing = keyEvents.find(
      (keyEvent) => keyEvent.eventName === input.eventName,
    );
    const canApply = scopes.includes(GA4_EDIT_SCOPE);
    const result = {
      status: "ok" as const,
      source: {
        provider: "google_analytics_admin" as const,
        propertyId: connection.propertyId,
        propertyDisplayName: connection.propertyDisplayName,
      },
      eventName: input.eventName,
      canApply,
    };

    // Nothing to do: already marked, or asked to remove a mark that is not
    // there. An existing key event keeps its counting method.
    if (Boolean(existing) !== input.remove) {
      return {
        ...result,
        mode: "unchanged" as const,
        changes: [],
        note: existing
          ? `${input.eventName} is already a key event, counted ${existing.countingMethod}.`
          : `${input.eventName} is not a key event.`,
        revert: null,
      };
    }
    if (existing?.deletable === false) {
      throw new Ga4ReportError(
        "validation_error",
        `Google does not allow removing the key event ${input.eventName}.`,
      );
    }

    const changes = [
      {
        field: "keyEvent",
        eventName: input.eventName,
        before: existing?.countingMethod ?? null,
        after: input.remove ? null : input.countingMethod,
      },
    ];
    if (!input.apply) {
      return {
        ...result,
        mode: "preview" as const,
        changes,
        note: canApply ? null : READ_ONLY_CONNECTION,
        revert: null,
      };
    }
    if (!canApply) {
      throw new Ga4ReportError("ga4_reconnect_required", READ_ONLY_CONNECTION);
    }

    try {
      if (existing) {
        // Google always returns the resource name; without it there is
        // nothing to address the delete to.
        if (!existing.name) throw new Ga4MalformedResponseError();
        await client.deleteKeyEvent(existing.name);
      } else {
        await client.createKeyEvent(connection.propertyId, {
          eventName: input.eventName,
          countingMethod: input.countingMethod,
        });
      }
    } catch (error) {
      // mapGa4ReportError words these two for reads; a refused write has
      // other causes.
      if (error instanceof Ga4AdminApiError && error.status === 403) {
        throw new Ga4ReportError(
          "ga4_property_inaccessible",
          "Google Analytics refused the change. The connected Google account needs the Editor role on this property.",
        );
      }
      if (error instanceof Ga4AdminApiError && error.status === 400) {
        throw new Ga4ReportError(
          "validation_error",
          `Google Analytics rejected ${input.eventName} as a key event.`,
        );
      }
      throw error;
    }
    return {
      ...result,
      mode: "applied" as const,
      changes,
      note: input.remove
        ? null
        : "Key events are not retroactive: Google Analytics counts this one from now on.",
      revert: existing
        ? {
            eventName: input.eventName,
            countingMethod: existing.countingMethod,
          }
        : { eventName: input.eventName, remove: true },
    };
  } catch (error) {
    mapGa4ReportError(error);
  }
}

export const Ga4KeyEventService = { updateKeyEvent };
