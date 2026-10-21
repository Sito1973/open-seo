import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { hasOrgPermission } from "@/lib/org-permissions";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { GbpService } from "@/server/features/gbp/services/GbpService";
import { hasGoogleOAuthConfig } from "@/server/features/google/oauth-config";
import { getPublicOrigin } from "@/server/mcp/public-origin";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "@/serverFunctions/middleware";

// Google Business Profile, self-hosted only: GbpService refuses hosted mode.

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const setAccountSchema = projectScopedSchema.extend({
  accountId: z.string().min(1),
  accountName: z.string().regex(/^accounts\/\d+$/),
});
const startLinkSchema = z.object({ callbackURL: z.string().min(1) });

export const getGbpConnection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const [connection, currentUserHasGrant, googleOAuthConfigured] =
      await Promise.all([
        GbpService.getConnection(context.projectId),
        GbpService.userHasGrant(context.userId),
        hasGoogleOAuthConfig(),
      ]);
    return {
      connected: Boolean(connection),
      canManage: hasOrgPermission(context.role, { integration: ["manage"] }),
      currentUserHasGrant,
      googleOAuthConfigured,
      accountName: connection?.accountName ?? null,
      accountDisplayName: connection?.accountDisplayName ?? null,
      connectedByEmail: connection?.connectedAccountEmail ?? null,
    };
  });

export const listGbpAccounts = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const [accountList, connection] = await Promise.all([
      GbpService.listAccountsForUserWithGrantStatus(context.userId),
      GbpService.getConnection(context.projectId),
    ]);
    return {
      accounts: accountList.accounts.map((grant) => ({
        ...grant,
        businessAccounts: grant.businessAccounts.map((businessAccount) => ({
          ...businessAccount,
          isSelected:
            connection?.googleAccountId === grant.accountId &&
            connection.accountName === businessAccount.name,
        })),
      })),
    };
  });

export const setGbpAccount = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(setAccountSchema)
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    const connection = await GbpService.setAccount({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      accountId: data.accountId,
      accountName: data.accountName,
    });
    return {
      connected: true as const,
      accountName: connection.accountName,
      accountDisplayName: connection.accountDisplayName,
      connectedByEmail: connection.connectedAccountEmail,
    };
  });

export const disconnectGbp = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    await GbpService.disconnect({ projectId: context.projectId });
    return { connected: false as const };
  });

export const startGbpLink = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(startLinkSchema)
  .handler(async ({ data, context }) => ({
    url: await GbpService.startLink({
      userId: context.userId,
      callbackURL: data.callbackURL,
      publicOrigin: getPublicOrigin(getRequest()),
    }),
  }));
