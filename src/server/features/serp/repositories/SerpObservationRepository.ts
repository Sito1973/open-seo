import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  serpObservationFeatures,
  serpObservationResults,
  serpObservations,
} from "@/db/schema";
import { normalizeKeyword } from "@/server/features/keywords/services/research/helpers";

type ObservationRow = typeof serpObservations.$inferInsert;
type ResultRow = Omit<
  typeof serpObservationResults.$inferInsert,
  "observationId"
>;

export type SerpObservationOrigin = ObservationRow["origin"];

/** What makes two requests the same Google search for one organization. */
type SerpSearch = Pick<
  ObservationRow,
  "organizationId" | "keyword" | "locationCode" | "languageCode" | "device"
> & { locationName?: string | null };

function searchColumns(search: SerpSearch) {
  return {
    organizationId: search.organizationId,
    keyword: normalizeKeyword(search.keyword),
    locationCode: search.locationCode,
    languageCode: search.languageCode,
    locationName: search.locationName ?? null,
    device: search.device,
  };
}

/** Saves one first results page, its rows and its SERP features at once. */
async function record(
  input: SerpSearch & {
    origin: SerpObservationOrigin;
    results: ResultRow[];
    features: string[];
  },
) {
  const id = crypto.randomUUID();
  await runBatch((tx) => [
    tx.insert(serpObservations).values({
      id,
      ...searchColumns(input),
      origin: input.origin,
      observedAt: new Date().toISOString(),
    }),
    ...input.results.map((row) =>
      tx.insert(serpObservationResults).values({ ...row, observationId: id }),
    ),
    ...[...new Set(input.features)].map((feature) =>
      tx.insert(serpObservationFeatures).values({ observationId: id, feature }),
    ),
  ]);
}

/**
 * The organization's latest first page for this search observed at or after
 * `since` (an ISO timestamp), or null. Another organization's pages never
 * match.
 */
async function findLatest(input: SerpSearch & { since: string }) {
  const search = searchColumns(input);
  const [observation] = await db
    .select({
      id: serpObservations.id,
      observedAt: serpObservations.observedAt,
    })
    .from(serpObservations)
    .where(
      and(
        eq(serpObservations.organizationId, search.organizationId),
        eq(serpObservations.locationCode, search.locationCode),
        eq(serpObservations.languageCode, search.languageCode),
        eq(serpObservations.keyword, search.keyword),
        eq(serpObservations.device, search.device),
        search.locationName == null
          ? isNull(serpObservations.locationName)
          : eq(serpObservations.locationName, search.locationName),
        gte(serpObservations.observedAt, input.since),
      ),
    )
    .orderBy(desc(serpObservations.observedAt))
    .limit(1);
  if (!observation) return null;

  const [results, features] = await Promise.all([
    db
      .select()
      .from(serpObservationResults)
      .where(eq(serpObservationResults.observationId, observation.id))
      .orderBy(asc(serpObservationResults.position)),
    db
      .select({ feature: serpObservationFeatures.feature })
      .from(serpObservationFeatures)
      .where(eq(serpObservationFeatures.observationId, observation.id)),
  ]);
  return {
    observedAt: observation.observedAt,
    organic: results.filter((row) => row.section === "organic"),
    localPack: results.filter((row) => row.section === "local_pack"),
    features: features.map((row) => row.feature),
  };
}

export const SerpObservationRepository = { record, findLatest };
