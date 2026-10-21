import { sql } from "drizzle-orm";
import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Keep this definition structurally identical to ../gbp.schema.ts.
export const gbpConnections = pgTable(
  "gbp_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    accountName: text("account_name").notNull(),
    accountDisplayName: text("account_display_name").notNull(),
    connectedByUserId: text("connected_by_user_id").notNull(),
    googleAccountId: text("google_account_id").notNull(),
    connectedAccountEmail: text("connected_account_email"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
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
