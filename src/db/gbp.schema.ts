import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

// Google Business Profile account bound to a project (self-hosted only). It
// holds identifiers only: Business Profile terms forbid keeping reviews,
// metrics or keyword data, so those are fetched on demand and never stored.
// OAuth credentials stay in Better Auth's account table under the dedicated
// "google-business-profile" provider.
export const gbpConnections = sqliteTable(
  "gbp_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Account Management API resource name, e.g. "accounts/123456".
    accountName: text("account_name").notNull(),
    accountDisplayName: text("account_display_name").notNull(),
    connectedByUserId: text("connected_by_user_id").notNull(),
    // Google subject of the grant that reads this account.
    googleAccountId: text("google_account_id").notNull(),
    connectedAccountEmail: text("connected_account_email"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("gbp_connections_project_idx").on(table.projectId),
    index("gbp_connections_organization_idx").on(table.organizationId),
    index("gbp_connections_connector_idx").on(
      table.connectedByUserId,
      table.googleAccountId,
    ),
  ],
);
