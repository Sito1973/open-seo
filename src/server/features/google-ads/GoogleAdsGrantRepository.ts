import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { account } from "@/db/schema";
import { GOOGLE_ADS_OAUTH_PROVIDER_ID } from "@/shared/google-ads";

function grantsOf(userId: string) {
  return and(
    eq(account.userId, userId),
    eq(account.providerId, GOOGLE_ADS_OAUTH_PROVIDER_ID),
  );
}

/** The user's most recently linked Google Ads grant. */
async function getLatestGrant(userId: string) {
  const [grant] = await db
    .select({ accountId: account.accountId })
    .from(account)
    .where(grantsOf(userId))
    .orderBy(desc(account.updatedAt))
    .limit(1);
  return grant ?? null;
}

async function removeGrants(userId: string): Promise<void> {
  await db.delete(account).where(grantsOf(userId));
}

export const GoogleAdsGrantRepository = { getLatestGrant, removeGrants };
