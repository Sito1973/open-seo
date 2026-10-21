ALTER TABLE "ai_sources" ADD COLUMN "placement" text;--> statement-breakpoint
ALTER TABLE "ai_sources" ADD COLUMN "inline_order" integer;--> statement-breakpoint
ALTER TABLE "ai_trackers" ADD COLUMN "google_ai_mode" boolean DEFAULT false NOT NULL;