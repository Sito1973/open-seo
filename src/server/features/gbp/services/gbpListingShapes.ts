import { sortBy } from "remeda";
import { z } from "zod";
import { shiftGa4Date } from "@/server/features/ga4/services/Ga4Dates";
import { AppError } from "@/server/lib/errors";
import {
  dayOfWeekSchema,
  type attributeMetadataResponseSchema,
  type listingLocationSchema,
  type specialHourPeriodSchema,
  type timePeriodSchema,
} from "@/server/lib/gbpApiSchemas";
import type { GbpLocation } from "@/server/lib/gbpClient";
import type { RawAttribute } from "@/server/lib/gbpListingApi";

// The shapes the Business Profile edit tools read and write, and their
// mapping to Google's: hours as { day, open: "HH:MM", close }, attribute
// values as true/false, a choice or a URL. The listing read returns the same
// shapes the edit tools take, so read, preview, apply and revert round-trip.

export const GBP_DAYS = dayOfWeekSchema.options;

type Day = z.infer<typeof dayOfWeekSchema>;
type GoogleTimePeriod = z.infer<typeof timePeriodSchema>;
type GoogleSpecialPeriod = z.infer<typeof specialHourPeriodSchema>;
type ListingLocation = z.infer<typeof listingLocationSchema>;
type AttributeMetadata = NonNullable<
  z.infer<typeof attributeMetadataResponseSchema>["attributeMetadata"]
>[number];

/** Hours in the location's local time; `close` at or before `open` ends the
 *  next day, and 24:00 is midnight at the end of `day`. */
export type Hours = { day: Day; open: string; close: string; closeDay?: Day };
export type SpecialHours =
  | { date: string; closed: true }
  | { date: string; open: string; close: string };
export type MoreHours = { hoursTypeId: string; periods: Hours[] };

/** A link attribute can hold several URLs; one is a plain string. */
export type AttributeValue = boolean | string | string[] | null;

export type PostInput = {
  topicType: "STANDARD" | "EVENT" | "OFFER";
  summary: string;
  callToAction?: { actionType: string; url?: string };
  event?: {
    title: string;
    startDate: string;
    endDate: string;
    startTime?: string;
    endTime?: string;
  };
  offer?: {
    couponCode?: string;
    redeemOnlineUrl?: string;
    termsConditions?: string;
  };
  photoUrl?: string;
};

export type LocationInput = {
  projectId: string;
  location?: string;
  projectDomain: string | null;
};

export type EditResult = {
  location: string;
  title: string;
  /** unchanged: every value already matched, so Google was not called. */
  mode: "preview" | "applied" | "unchanged";
  /** google: Google validated the edit without saving it (validateOnly). */
  validatedBy: "google" | "openseo";
  changes: Array<{ field: string; before: unknown; after: unknown }>;
  /** Arguments for the same tool that restore the previous values. */
  revert: Record<string, unknown> | null;
  review?: {
    rating: number | null;
    comment: string | null;
    reviewer: string | null;
    createTime: string;
  };
  post?: { name: string; state: string | null; searchUrl: string | null };
  note?: string | null;
};

// --- Hours: Google TimePeriod <-> { day, open: "HH:MM", close } ---

const pad = (value: number) => String(value).padStart(2, "0");

const toHhmm = (time: GoogleTimePeriod["openTime"]) =>
  `${pad(time?.hours ?? 0)}:${pad(time?.minutes ?? 0)}`;

function toTimeOfDay(hhmm: string) {
  const [hours = 0, minutes = 0] = hhmm.split(":").map(Number);
  return { hours, minutes };
}

const endsNextDay = (open: string, close: string) =>
  close !== "24:00" && close <= open;

function inferredCloseDay(day: Day, open: string, close: string): Day {
  if (!endsNextDay(open, close)) return day;
  return GBP_DAYS[(GBP_DAYS.indexOf(day) + 1) % GBP_DAYS.length] ?? day;
}

export function toGooglePeriod(hours: Hours): GoogleTimePeriod {
  return {
    openDay: hours.day,
    openTime: toTimeOfDay(hours.open),
    closeDay:
      hours.closeDay ?? inferredCloseDay(hours.day, hours.open, hours.close),
    closeTime: toTimeOfDay(hours.close),
  };
}

/** closeDay is kept only when the open/close times would not imply it. */
function fromGooglePeriod(period: GoogleTimePeriod): Hours {
  const open = toHhmm(period.openTime);
  const close = toHhmm(period.closeTime);
  return {
    day: period.openDay,
    open,
    close,
    ...(period.closeDay === inferredCloseDay(period.openDay, open, close)
      ? {}
      : { closeDay: period.closeDay }),
  };
}

const sortHours = (hours: Hours[]) =>
  sortBy(
    hours,
    (period) => GBP_DAYS.indexOf(period.day),
    (period) => period.open,
  );

/** Round-trips input hours so they compare equal to what Google returns. */
export const normalizeHours = (hours: Hours[]) =>
  sortHours(hours.map((period) => fromGooglePeriod(toGooglePeriod(period))));

function toGoogleDate(isoDate: string) {
  const [year = 0, month = 0, day = 0] = isoDate.split("-").map(Number);
  return { year, month, day };
}

const fromGoogleDate = (date: GoogleSpecialPeriod["startDate"]) =>
  `${date.year}-${pad(date.month)}-${pad(date.day ?? 1)}`;

export function toGoogleSpecial(hours: SpecialHours): GoogleSpecialPeriod {
  const startDate = toGoogleDate(hours.date);
  if ("closed" in hours) return { startDate, closed: true };
  return {
    startDate,
    openTime: toTimeOfDay(hours.open),
    ...(endsNextDay(hours.open, hours.close)
      ? { endDate: toGoogleDate(shiftGa4Date(hours.date, 1)) }
      : {}),
    closeTime: toTimeOfDay(hours.close),
  };
}

function fromGoogleSpecial(period: GoogleSpecialPeriod): SpecialHours {
  const date = fromGoogleDate(period.startDate);
  if (period.closed) return { date, closed: true };
  return {
    date,
    open: toHhmm(period.openTime),
    close: toHhmm(period.closeTime),
  };
}

export const sortSpecialHours = (hours: SpecialHours[]) =>
  sortBy(
    hours,
    (period) => period.date,
    (period) => ("open" in period ? period.open : ""),
  );

// --- Listing fields ---

export function toListing(raw: ListingLocation) {
  return {
    primaryCategory: raw.categories?.primaryCategory
      ? {
          name: raw.categories.primaryCategory.name,
          displayName: raw.categories.primaryCategory.displayName ?? null,
        }
      : null,
    additionalCategories: (raw.categories?.additionalCategories ?? []).map(
      (category) => ({
        name: category.name,
        displayName: category.displayName ?? null,
      }),
    ),
    description: raw.profile?.description || null,
    websiteUri: raw.websiteUri || null,
    primaryPhone: raw.phoneNumbers?.primaryPhone || null,
    additionalPhones: raw.phoneNumbers?.additionalPhones ?? [],
    regularHours: sortHours(
      (raw.regularHours?.periods ?? []).map(fromGooglePeriod),
    ),
    specialHours: sortSpecialHours(
      (raw.specialHours?.specialHourPeriods ?? []).map(fromGoogleSpecial),
    ),
    moreHours: (raw.moreHours ?? []).map((entry) => ({
      hoursTypeId: entry.hoursTypeId,
      periods: sortHours((entry.periods ?? []).map(fromGooglePeriod)),
    })),
    openStatus: raw.openInfo?.status ?? null,
    serviceItems: (raw.serviceItems ?? []).flatMap((item) => {
      const label =
        item.freeFormServiceItem?.label?.displayName ??
        item.structuredServiceItem?.serviceTypeId;
      return label ? [label] : [];
    }),
  };
}

// --- Attributes ---

export function attributeValue(raw: RawAttribute | undefined): AttributeValue {
  if (!raw) return null;
  if (raw.uriValues?.length) {
    const uris = raw.uriValues.map((value) => value.uri);
    return uris.length === 1 ? (uris[0] ?? null) : uris;
  }
  if (raw.repeatedEnumValue) return raw.repeatedEnumValue.setValues ?? [];
  const value = raw.values?.[0];
  return typeof value === "boolean" || typeof value === "string" ? value : null;
}

export const enumOptions = (metadata: AttributeMetadata) =>
  (metadata.valueMetadata ?? []).flatMap((option) =>
    typeof option.value === "string"
      ? [
          {
            value: option.value,
            displayName: option.displayName ?? option.value,
          },
        ]
      : [],
  );

const httpsUrlSchema = z.url({ protocol: /^https$/ });

/** Rejects values Google would refuse, before anything is written. */
export function checkAttributeValue(
  metadata: AttributeMetadata,
  value: AttributeValue,
) {
  const name = metadata.parent;
  const reject = (message: string) => {
    throw new AppError("VALIDATION_ERROR", `${name} ${message}`);
  };
  const type = metadata.valueType;
  if (type !== "BOOL" && type !== "ENUM" && type !== "URL") {
    reject(`(${type ?? "unknown type"}) is not editable here.`);
  }
  if (value === null) return;
  if (type === "BOOL" && typeof value !== "boolean") {
    reject("takes true or false.");
  }
  if (type === "ENUM") {
    const allowed = enumOptions(metadata).map((option) => option.value);
    if (typeof value !== "string" || !allowed.includes(value)) {
      reject(`takes one of: ${allowed.join(", ")}.`);
    }
  }
  if (
    type === "URL" &&
    ![value].flat().every((uri) => httpsUrlSchema.safeParse(uri).success)
  ) {
    reject("takes an https URL, or a list of them.");
  }
}

/** The value as the listing read reports it: one URL as a plain string. */
export const normalizeAttributeValue = (value: AttributeValue) =>
  Array.isArray(value) && value.length === 1 ? (value[0] ?? null) : value;

export function toRawAttribute(
  name: string,
  valueType: string | undefined,
  value: boolean | string | string[],
): RawAttribute {
  // Every URL is sent: Google replaces the attribute's whole list.
  return valueType === "URL"
    ? { name, uriValues: [value].flat().map((uri) => ({ uri: String(uri) })) }
    : { name, values: [value] };
}

// --- Posts ---

export function toLocalPost(post: PostInput, languageCode: string) {
  const { event } = post;
  return {
    languageCode,
    summary: post.summary,
    topicType: post.topicType,
    ...(post.callToAction ? { callToAction: post.callToAction } : {}),
    ...(event
      ? {
          event: {
            title: event.title,
            // Google takes a schedule only with all four fields.
            schedule: {
              startDate: toGoogleDate(event.startDate),
              startTime: toTimeOfDay(event.startTime ?? "00:00"),
              endDate: toGoogleDate(event.endDate),
              endTime: toTimeOfDay(event.endTime ?? "23:59"),
            },
          },
        }
      : {}),
    ...(post.offer ? { offer: post.offer } : {}),
    ...(post.photoUrl
      ? { media: [{ mediaFormat: "PHOTO", sourceUrl: post.photoUrl }] }
      : {}),
  };
}

/** The location every result names. */
export const where = (location: GbpLocation) => ({
  location: location.location,
  title: location.title,
});
