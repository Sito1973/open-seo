ALTER TABLE `ai_sources` ADD `placement` text;--> statement-breakpoint
ALTER TABLE `ai_sources` ADD `inline_order` integer;--> statement-breakpoint
ALTER TABLE `ai_trackers` ADD `google_ai_mode` integer DEFAULT false NOT NULL;