import {
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

// Keep these definitions structurally identical to ../serp.schema.ts.
export const serpObservations = pgTable(
  "serp_observations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
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

export const serpObservationResults = pgTable(
  "serp_observation_results",
  {
    observationId: text("observation_id")
      .notNull()
      .references(() => serpObservations.id, { onDelete: "cascade" }),
    section: text("section", { enum: ["organic", "local_pack"] }).notNull(),
    position: integer("position").notNull(),
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

export const serpObservationFeatures = pgTable(
  "serp_observation_features",
  {
    observationId: text("observation_id")
      .notNull()
      .references(() => serpObservations.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
  },
  (t) => [primaryKey({ columns: [t.observationId, t.feature] })],
);

export const keywordDifficultyEstimates = pgTable(
  "keyword_difficulty_estimates",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    keywordDifficulty: integer("keyword_difficulty").notNull(),
    localScore: integer("local_score"),
    organicScore: integer("organic_score"),
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
