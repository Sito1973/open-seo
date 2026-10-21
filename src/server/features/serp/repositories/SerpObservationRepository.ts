import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { chunk } from "remeda";
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

// D1 caps bound parameters at 100 per statement; leave headroom for the
// organization and market filters.
const QUERY_CHUNK_SIZE = 80;

/** Where a search ran: country, language and city (null for the country). */
type SerpMarket = Pick<
  ObservationRow,
  "organizationId" | "locationCode" | "languageCode"
> & { locationName?: string | null };

/** What makes two requests the same Google search for one organization. */
type SerpSearch = SerpMarket & Pick<ObservationRow, "keyword" | "device">;

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

/** The organization's pages in this market observed at or after `since`. */
function inMarketSince(market: SerpMarket, since: string) {
  return and(
    eq(serpObservations.organizationId, market.organizationId),
    eq(serpObservations.locationCode, market.locationCode),
    eq(serpObservations.languageCode, market.languageCode),
    market.locationName == null
      ? isNull(serpObservations.locationName)
      : eq(serpObservations.locationName, market.locationName),
    gte(serpObservations.observedAt, since),
  );
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

/** Each observation with its organic results, local pack and features. */
async function readPages<Observation extends { id: string }>(
  observations: Observation[],
) {
  const chunks = await Promise.all(
    chunk(
      observations.map((observation) => observation.id),
      QUERY_CHUNK_SIZE,
    ).map((ids) =>
      Promise.all([
        db
          .select()
          .from(serpObservationResults)
          .where(inArray(serpObservationResults.observationId, ids))
          .orderBy(asc(serpObservationResults.position)),
        db
          .select()
          .from(serpObservationFeatures)
          .where(inArray(serpObservationFeatures.observationId, ids)),
      ]),
    ),
  );
  const results = chunks.flatMap(([rows]) => rows);
  const features = chunks.flatMap(([, rows]) => rows);
  return observations.map((observation) => {
    const rows = results.filter((row) => row.observationId === observation.id);
    return {
      ...observation,
      organic: rows.filter((row) => row.section === "organic"),
      localPack: rows.filter((row) => row.section === "local_pack"),
      features: features
        .filter((row) => row.observationId === observation.id)
        .map((row) => row.feature),
    };
  });
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
        inMarketSince(search, input.since),
        eq(serpObservations.keyword, search.keyword),
        eq(serpObservations.device, search.device),
      ),
    )
    .orderBy(desc(serpObservations.observedAt))
    .limit(1);
  if (!observation) return null;
  const [page] = await readPages([observation]);
  return page ?? null;
}

/**
 * For each keyword, the organization's latest first page of it in this market
 * observed at or after `since`, from either device. Keyed by normalized
 * keyword; a keyword without one is missing.
 */
async function findLatestForKeywords(
  input: SerpMarket & { keywords: string[]; since: string },
) {
  const keywords = [...new Set(input.keywords.map(normalizeKeyword))];
  // A keyword's observations all fall in one chunk, so the newest one per
  // keyword is the first in its chunk's order.
  const observations = (
    await Promise.all(
      chunk(keywords, QUERY_CHUNK_SIZE).map((slice) =>
        db
          .select({
            id: serpObservations.id,
            keyword: serpObservations.keyword,
            device: serpObservations.device,
            observedAt: serpObservations.observedAt,
          })
          .from(serpObservations)
          .where(
            and(
              inMarketSince(input, input.since),
              inArray(serpObservations.keyword, slice),
            ),
          )
          .orderBy(desc(serpObservations.observedAt)),
      ),
    )
  ).flat();
  const latest = new Map<string, (typeof observations)[number]>();
  for (const observation of observations) {
    if (!latest.has(observation.keyword))
      latest.set(observation.keyword, observation);
  }
  const pages = await readPages([...latest.values()]);
  return new Map(pages.map((page) => [page.keyword, page]));
}

export const SerpObservationRepository = {
  record,
  findLatest,
  findLatestForKeywords,
};
