CREATE TABLE `keyword_difficulty_estimates` (
	`project_id` text NOT NULL,
	`keyword` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`keyword_difficulty` integer NOT NULL,
	`local_score` integer,
	`organic_score` integer,
	`location_name` text,
	`observed_at` text NOT NULL,
	`computed_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `keyword`, `location_code`, `language_code`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
