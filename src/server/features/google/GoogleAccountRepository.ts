import { and, count, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  account,
  ga4Connections,
  gbpConnections,
  gscConnections,
} from "@/db/schema";
import type { GoogleLinkProvider } from "@/shared/google-link";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";
import { GBP_OAUTH_PROVIDER_ID } from "@/shared/gbp";
import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";

type AccountInput = {
  userId: string;
  provider: GoogleLinkProvider;
  accountId: string;
};

function grantOf(input: AccountInput, providerId: string) {
  return and(
    eq(account.userId, input.userId),
    eq(account.providerId, providerId),
    eq(account.accountId, input.accountId),
  );
}

function scope(input: AccountInput) {
  switch (input.provider) {
    case "gsc":
      return {
        connections: gscConnections,
        grant: grantOf(input, GSC_OAUTH_PROVIDER_ID),
        usage: and(
          eq(gscConnections.connectedByUserId, input.userId),
          // Legacy GSC mappings can use any of this user's grants.
          or(
            eq(gscConnections.gscAccountId, input.accountId),
            isNull(gscConnections.gscAccountId),
          ),
        ),
      };
    case "ga4":
      return {
        connections: ga4Connections,
        grant: grantOf(input, GA4_OAUTH_PROVIDER_ID),
        usage: and(
          eq(ga4Connections.connectedByUserId, input.userId),
          eq(ga4Connections.ga4AccountId, input.accountId),
        ),
      };
    case "gbp":
      return {
        connections: gbpConnections,
        grant: grantOf(input, GBP_OAUTH_PROVIDER_ID),
        usage: and(
          eq(gbpConnections.connectedByUserId, input.userId),
          eq(gbpConnections.googleAccountId, input.accountId),
        ),
      };
  }
}

async function getRemovalImpact(input: AccountInput) {
  const { connections, usage } = scope(input);
  const [result] = await db
    .select({ projectCount: count() })
    .from(connections)
    .where(usage);
  return { projectCount: result?.projectCount ?? 0 };
}

async function remove(input: AccountInput) {
  const { connections, grant, usage } = scope(input);
  // Atomic on D1 and Postgres: never leave a partial account removal.
  // Both deletes are scoped to the authenticated owner, including on retries
  // after this Google identity has been linked to a different OpenSEO user.
  await runBatch((tx) => [
    tx.delete(connections).where(usage),
    tx.delete(account).where(grant),
  ]);
}

export const GoogleAccountRepository = { getRemovalImpact, remove };
