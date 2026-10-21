CREATE TABLE `serp_observation_features` (
	`observation_id` text NOT NULL,
	`feature` text NOT NULL,
	PRIMARY KEY(`observation_id`, `feature`),
	FOREIGN KEY (`observation_id`) REFERENCES `serp_observations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `serp_observation_results` (
	`observation_id` text NOT NULL,
	`section` text NOT NULL,
	`position` integer NOT NULL,
	`domain` text,
	`url` text,
	`title` text,
	`rating` real,
	`reviews_count` integer,
	PRIMARY KEY(`observation_id`, `section`, `position`),
	FOREIGN KEY (`observation_id`) REFERENCES `serp_observations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `serp_observation_results_domain_idx` ON `serp_observation_results` (`domain`);--> statement-breakpoint
CREATE TABLE `serp_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`keyword` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`location_name` text,
	`device` text NOT NULL,
	`origin` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `serp_observations_lookup_idx` ON `serp_observations` (`organization_id`,`location_code`,`language_code`,`keyword`,`device`,`observed_at`);