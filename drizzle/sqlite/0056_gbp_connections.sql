CREATE TABLE `gbp_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`account_name` text NOT NULL,
	`account_display_name` text NOT NULL,
	`connected_by_user_id` text NOT NULL,
	`google_account_id` text NOT NULL,
	`connected_account_email` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gbp_connections_project_idx` ON `gbp_connections` (`project_id`);--> statement-breakpoint
CREATE INDEX `gbp_connections_organization_idx` ON `gbp_connections` (`organization_id`);--> statement-breakpoint
CREATE INDEX `gbp_connections_connector_idx` ON `gbp_connections` (`connected_by_user_id`,`google_account_id`);--> statement-breakpoint
DROP INDEX `account_google_grant_owner_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `account_google_grant_owner_idx` ON `account` (`user_id`,`provider_id`,`account_id`) WHERE "account"."provider_id" in ('google-search-console', 'google-analytics', 'google-business-profile');