import type { LocalSerpTaskOutcome } from "@/server/lib/dataforseo";
import {
  placesBudgetLine,
  searchGrid,
  type GooglePlace,
  type PlacesBudget,
} from "@/server/lib/googlePlaces";
import {
  KM_PER_DEGREE_LATITUDE,
  KM_PER_DEGREE_LONGITUDE,
  MIN_LONGITUDE_COSINE,
} from "@/server/mcp/tools/local-seo-shared";
import { getIsoCountryCode } from "@/shared/keyword-locations";

// Google Places (Places API New) behind the local-SEO tools on self-hosted
// installs without DataForSEO. Rows are mapped onto the DataForSEO row shape
// so every consumer reads one shape. This module must not import
// local-seo-tools.ts (import cycle).

const PLACES_SOURCE_NOTE =
  "Source: Google Maps (Places API). Ranks approximate the Maps app (no zoom, personalization or ads); compare only with other google_places results.";

const PLACES_STORAGE_NOTE =
  "Google Maps terms: keep listing details (names, addresses, phones, websites, ratings, review counts, hours, coordinates) in this chat. Do not copy them into save_report or update_project_context, and do not add competitors from these rows. Reports may keep place_id, ranks, grid coordinates, the user's own business details and your own conclusions.";

/** Google numbers days from Sunday (0) to Saturday (6). */
const WEEKDAYS_FROM_SUNDAY = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

type Clock = { hour: number; minute: number };
type Span = { open: Clock; close: Clock };
type Period = NonNullable<
  NonNullable<GooglePlace["regularOpeningHours"]>["periods"]
>[number];

export function placesLocale(
  languageCode: string,
  project: { locationCode: number },
) {
  return {
    languageCode,
    regionCode: getIsoCountryCode(project.locationCode).toUpperCase(),
  };
}

function parseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Places has no cid field; its googleMapsUri is "https://maps.google.com/?cid=<cid>". */
function cidFromMapsUri(uri: string | undefined): string | null {
  return parseUrl(uri)?.searchParams.get("cid") ?? null;
}

function toTimetable(
  periods: Period[] | undefined,
): Record<string, Span[]> | null {
  if (!periods?.length) return null;
  const timetable: Record<string, Span[]> = Object.fromEntries(
    WEEKDAYS_FROM_SUNDAY.map((day) => [day, []]),
  );
  for (const { open, close } of periods) {
    // Google marks an always-open place with a single period and no close.
    if (!close) {
      return Object.fromEntries(
        WEEKDAYS_FROM_SUNDAY.map((day) => [
          day,
          [{ open: { hour: 0, minute: 0 }, close: { hour: 24, minute: 0 } }],
        ]),
      );
    }
    timetable[WEEKDAYS_FROM_SUNDAY[open.day]]?.push({
      open: { hour: open.hour, minute: open.minute },
      close: { hour: close.hour, minute: close.minute },
    });
  }
  return timetable;
}

function currentStatus(place: GooglePlace): string | null {
  if (place.businessStatus === "CLOSED_PERMANENTLY") return "closed_forever";
  if (place.businessStatus === "CLOSED_TEMPORARILY") {
    return "temporarily_closed";
  }
  const openNow = place.regularOpeningHours?.openNow;
  if (openNow == null) return null;
  return openNow ? "open" : "close";
}

/** One listing in the DataForSEO local row shape. */
export function toLocalRow(place: GooglePlace) {
  const priceLevel = place.priceLevel?.replace(/^PRICE_LEVEL_/, "");
  return {
    title: place.displayName?.text ?? null,
    category: place.primaryTypeDisplayName?.text ?? null,
    address: place.formattedAddress ?? null,
    phone: place.nationalPhoneNumber ?? null,
    url: place.websiteUri ?? null,
    domain: parseUrl(place.websiteUri)?.hostname.replace(/^www\./, "") ?? null,
    rating: {
      value: place.rating ?? null,
      votes_count: place.userRatingCount ?? null,
    },
    price_level:
      priceLevel && priceLevel !== "UNSPECIFIED"
        ? priceLevel.toLowerCase()
        : null,
    cid: cidFromMapsUri(place.googleMapsUri),
    place_id: place.id,
    latitude: place.location?.latitude ?? null,
    longitude: place.location?.longitude ?? null,
    check_url: place.googleMapsUri ?? null,
    work_hours: {
      current_status: currentStatus(place),
      timetable: toTimetable(place.regularOpeningHours?.periods),
    },
  };
}

/**
 * The `locationRestriction` rectangle ±radiusKm around a center. Text Search
 * restricts only to rectangles; its corners reach 1.41× the radius.
 */
export function boundsAround(
  center: { latitude: number; longitude: number },
  radiusKm: number,
) {
  const latitudeDelta = Math.min(90, radiusKm / KM_PER_DEGREE_LATITUDE);
  // Google rejects a rectangle wider than 180 degrees; a low longitude above
  // the high one crosses the antimeridian.
  const longitudeDelta = Math.min(
    90,
    radiusKm /
      (KM_PER_DEGREE_LONGITUDE *
        Math.max(
          Math.abs(Math.cos((center.latitude * Math.PI) / 180)),
          MIN_LONGITUDE_COSINE,
        )),
  );
  return {
    low: {
      latitude: Math.max(-90, center.latitude - latitudeDelta),
      longitude: wrapLongitude(center.longitude - longitudeDelta),
    },
    high: {
      latitude: Math.min(90, center.latitude + latitudeDelta),
      longitude: wrapLongitude(center.longitude + longitudeDelta),
    },
  };
}

function wrapLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

/** Provider fields every Places response adds to its structured content. */
export function placesResponseFields(
  budget: PlacesBudget,
  places: GooglePlace[],
) {
  const attributions = new Map<
    string,
    { provider: string | null; providerUri: string | null }
  >();
  for (const attribution of places.flatMap(
    (place) => place.attributions ?? [],
  )) {
    const provider = attribution.provider ?? null;
    const providerUri = attribution.providerUri ?? null;
    if (!provider && !providerUri) continue;
    attributions.set(`${provider}|${providerUri}`, { provider, providerUri });
  }
  return {
    provider: "google_places" as const,
    attribution: "Google Maps",
    attributions: [...attributions.values()],
    budget,
  };
}

/**
 * Source, attribution, storage and budget lines every Places response text
 * ends with. Google requires third-party attributions to be shown with the
 * results, and most clients give the model only the text.
 */
export function placesNotes({
  budget,
  attributions,
}: ReturnType<typeof placesResponseFields>): string[] {
  return [
    PLACES_SOURCE_NOTE,
    ...attributions.map(({ provider, providerUri }) =>
      provider && providerUri
        ? `Also attribute: ${provider} (${providerUri})`
        : `Also attribute: ${provider ?? providerUri}`,
    ),
    PLACES_STORAGE_NOTE,
    placesBudgetLine(budget),
  ];
}

/**
 * Runs a rank grid on Places, one Text Search Pro call per point, and returns
 * outcomes in the DataForSEO collector's shape so the grid tool ranks both
 * providers with the same matcher.
 */
export async function fetchPlacesGridOutcomes(
  apiKey: string,
  input: Parameters<typeof searchGrid>[1],
) {
  const { results, budget } = await searchGrid(apiKey, input);
  // Every point failing is a config or upstream problem; surface its error
  // (a refused key reads as such) instead of an empty grid.
  const firstFailure = results.find((result) => result.status === "rejected");
  if (firstFailure && results.every((result) => result.status === "rejected")) {
    throw firstFailure.reason;
  }

  const places: GooglePlace[] = [];
  const outcomes = results.map((result): LocalSerpTaskOutcome => {
    if (result.status === "rejected") {
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      console.warn(`[local-rank-grid] Places search failed: ${message}`);
      return { status: "failed", message };
    }
    places.push(...result.value);
    return {
      status: "completed",
      items: result.value.map((place, index) => ({
        title: place.displayName?.text ?? null,
        cid: cidFromMapsUri(place.googleMapsUri),
        place_id: place.id,
        rank_absolute: index + 1,
      })),
    };
  });
  return { outcomes, fields: placesResponseFields(budget, places), budget };
}
