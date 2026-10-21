CREATE TABLE "google_places_usage" (
	"month" text NOT NULL,
	"sku" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "google_places_usage_month_sku_pk" PRIMARY KEY("month","sku")
);
