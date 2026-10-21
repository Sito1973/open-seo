import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

// One store for the Google results pages this organization has fetched live
// from Bright Data: rank checks, SERP tools, keyword research and Google AI
// Overviews checks write the first page of each request here, so another site's rank check can
// reuse it instead of paying for the same search. Only the first page is kept,
// whatever the request's depth.
export const serpObservations = sqliteTable(
  "serp_observations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Trimmed and lowercased: Google answers a query the same in any case.
    keyword: text("keyword").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    // The city sent as Google's uule, or null for the whole country.
    locationName: text("location_name"),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    origin: text("origin", {
      enum: ["rank_check", "serp_tool", "research", "sample", "ai_visibility"],
    }).notNull(),
    observedAt: text("observed_at").notNull(),
  },
  (t) => [
    index("serp_observations_lookup_idx").on(
      t.organizationId,
      t.locationCode,
      t.languageCode,
      t.keyword,
      t.device,
      t.observedAt,
    ),
  ],
);

// The page's organic results and local pack, each ranked within its section.
// rating and reviews_count are set for the local pack only.
export const serpObservationResults = sqliteTable(
  "serp_observation_results",
  {
    observationId: text("observation_id")
      .notNull()
      .references(() => serpObservations.id, { onDelete: "cascade" }),
    section: text("section", { enum: ["organic", "local_pack"] }).notNull(),
    position: integer("position").notNull(),
    // The link's hostname without www.
    domain: text("domain"),
    url: text("url"),
    title: text("title"),
    rating: real("rating"),
    reviewsCount: integer("reviews_count"),
  },
  (t) => [
    primaryKey({ columns: [t.observationId, t.section, t.position] }),
    index("serp_observation_results_domain_idx").on(t.domain),
  ],
);

// SERP features the page showed, with DataForSEO's names (organic, local_pack,
// people_also_ask, ai_overview...). An AI Overview missing here was not
// detected; Google loads some after the page.
export const serpObservationFeatures = sqliteTable(
  "serp_observation_features",
  {
    observationId: text("observation_id")
      .notNull()
      .references(() => serpObservations.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
  },
  (t) => [primaryKey({ columns: [t.observationId, t.feature] })],
);

// OpenSEO's own keyword difficulty estimates, worked out from a saved first
// page (see estimateDifficulty in features/serp/services/difficultyEstimate.ts).
// They live here, never in keyword_metrics or rank_tracking_keywords, so an
// estimate is never mistaken for provider data and a metrics refresh never
// erases it; reads join them next to the provider's difficulty. One estimate
// per keyword and country market, like keyword_metrics: the latest one wins.
export const keywordDifficultyEstimates = sqliteTable(
  "keyword_difficulty_estimates",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Trimmed and lowercased.
    keyword: text("keyword").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    // 0-100, from the local pack and organic scores below.
    keywordDifficulty: integer("keyword_difficulty").notNull(),
    // From the local pack's review counts; null without a local pack.
    localScore: integer("local_score"),
    // From the top 10's Open PageRank; null without OPENPAGERANK_API_KEY.
    organicScore: integer("organic_score"),
    // The page it came from: its city (null for the whole country) and time.
    locationName: text("location_name"),
    observedAt: text("observed_at").notNull(),
    computedAt: text("computed_at").notNull(),
  },
  (t) => [
    primaryKey({
      // Named: the generated name is past Postgres' 63-character limit.
      name: "keyword_difficulty_estimates_pk",
      columns: [t.projectId, t.keyword, t.locationCode, t.languageCode],
    }),
  ],
);
