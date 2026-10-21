CREATE TABLE "serp_observation_features" (
	"observation_id" text NOT NULL,
	"feature" text NOT NULL,
	CONSTRAINT "serp_observation_features_observation_id_feature_pk" PRIMARY KEY("observation_id","feature")
);
--> statement-breakpoint
CREATE TABLE "serp_observation_results" (
	"observation_id" text NOT NULL,
	"section" text NOT NULL,
	"position" integer NOT NULL,
	"domain" text,
	"url" text,
	"title" text,
	"rating" real,
	"reviews_count" integer,
	CONSTRAINT "serp_observation_results_observation_id_section_position_pk" PRIMARY KEY("observation_id","section","position")
);
--> statement-breakpoint
CREATE TABLE "serp_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"keyword" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"location_name" text,
	"device" text NOT NULL,
	"origin" text NOT NULL,
	"observed_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "serp_observation_features" ADD CONSTRAINT "serp_observation_features_observation_id_serp_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."serp_observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_observation_results" ADD CONSTRAINT "serp_observation_results_observation_id_serp_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."serp_observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_observations" ADD CONSTRAINT "serp_observations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "serp_observation_results_domain_idx" ON "serp_observation_results" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "serp_observations_lookup_idx" ON "serp_observations" USING btree ("organization_id","location_code","language_code","keyword","device","observed_at");