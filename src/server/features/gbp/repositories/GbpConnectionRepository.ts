import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { account, gbpConnections } from "@/db/schema";
import { GBP_OAUTH_PROVIDER_ID } from "@/shared/gbp";

export type GbpConnection = typeof gbpConnections.$inferSelect;

async function getByProjectId(
  projectId: string,
): Promise<GbpConnection | null> {
  const rows = await db
    .select()
    .from(gbpConnections)
    .where(eq(gbpConnections.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

/** The user's Business Profile grants, one per linked Google account. */
async function listGrantsForUser(userId: string) {
  return db
    .select({ accountId: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GBP_OAUTH_PROVIDER_ID),
      ),
    );
}

async function upsert(input: {
  projectId: string;
  organizationId: string;
  accountName: string;
  accountDisplayName: string;
  connectedByUserId: string;
  googleAccountId: string;
  connectedAccountEmail: string | null;
}): Promise<GbpConnection> {
  const [row] = await db
    .insert(gbpConnections)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: gbpConnections.projectId,
      set: {
        organizationId: input.organizationId,
        accountName: input.accountName,
        accountDisplayName: input.accountDisplayName,
        connectedByUserId: input.connectedByUserId,
        googleAccountId: input.googleAccountId,
        connectedAccountEmail: sql`case
          when ${gbpConnections.connectedByUserId} = ${input.connectedByUserId}
            and ${gbpConnections.googleAccountId} = ${input.googleAccountId}
          then coalesce(${input.connectedAccountEmail}, ${gbpConnections.connectedAccountEmail})
          else ${input.connectedAccountEmail}
        end`,
        updatedAt: sql`(current_timestamp)`,
      },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert gbp_connection");
  return row;
}

async function deleteByProjectId(projectId: string): Promise<void> {
  await db
    .delete(gbpConnections)
    .where(eq(gbpConnections.projectId, projectId));
}

export const GbpConnectionRepository = {
  getByProjectId,
  listGrantsForUser,
  upsert,
  deleteByProjectId,
};
