import { isDeepEqual } from "remeda";
import {
  connectedClient,
  requireSelfHosted,
  resolveLocation,
} from "@/server/features/gbp/services/GbpService";
import {
  attributeValue,
  type AttributeValue,
  checkAttributeValue,
  type EditResult,
  enumOptions,
  type Hours,
  type LocationInput,
  type MoreHours,
  normalizeAttributeValue,
  normalizeHours,
  type SpecialHours,
  sortSpecialHours,
  toGooglePeriod,
  toGoogleSpecial,
  toListing,
  toRawAttribute,
  where,
} from "@/server/features/gbp/services/gbpListingShapes";
import { summarizeFoodMenus } from "@/server/features/gbp/services/gbpFoodMenuEdits";
import { AppError } from "@/server/lib/errors";

// Reads the owner's full listing and previews or applies edits to its
// profile fields and attributes. Every edit reads the current values first,
// so a preview shows before/after and an apply returns the arguments that
// restore the previous values. Nothing is written to Google unless `apply` is
// true, and nothing is stored locally.

type ListingFields = {
  primaryCategory?: string;
  additionalCategories?: string[];
  /** "" removes it. */
  description?: string;
  /** "" removes it. */
  websiteUri?: string;
  primaryPhone?: string;
  additionalPhones?: string[];
  regularHours?: Hours[];
  specialHours?: SpecialHours[];
  /** Merged by hoursTypeId; `periods: []` removes a type. */
  moreHours?: MoreHours[];
};

const FIELD_MASKS = [
  ["primaryCategory", "categories"],
  ["additionalCategories", "categories"],
  ["description", "profile.description"],
  ["websiteUri", "websiteUri"],
  ["primaryPhone", "phoneNumbers"],
  ["additionalPhones", "phoneNumbers"],
  ["regularHours", "regularHours"],
  ["specialHours", "specialHours"],
  ["moreHours", "moreHours"],
] as const satisfies ReadonlyArray<readonly [keyof ListingFields, string]>;

async function getListing(input: LocationInput) {
  await requireSelfHosted();
  const { connection, client, location } = await resolveLocation(input);
  const name = location.location;
  const v4 = { accountName: connection.accountName, location: name };
  const raw = await client.getLocation(name);
  // Google's JSON leaves out false flags, so a missing flag means false.
  const metadata = raw.metadata ?? {};
  const [current, available, updated, recentPosts, menus] = await Promise.all([
    client.getAttributes(name),
    client.listAttributeMetadata(name),
    metadata.hasPendingEdits || metadata.hasGoogleUpdated
      ? client.getGoogleUpdated(name)
      : { pendingFields: [], googleUpdatedFields: [] },
    metadata.canOperateLocalPost ? client.listLocalPosts(v4) : null,
    metadata.canHaveFoodMenus ? client.getFoodMenus(v4) : null,
  ]);
  const currentByName = new Map(current.map((entry) => [entry.name, entry]));
  const availableNames = new Set(available.map((entry) => entry.parent));
  return {
    ...where(location),
    listing: {
      title: raw.title || location.title,
      address: location.address,
      ...toListing(raw),
    },
    status: {
      hasVoiceOfMerchant: metadata.hasVoiceOfMerchant ?? false,
      hasPendingEdits: metadata.hasPendingEdits ?? false,
      ...updated,
      canOperateLocalPost: metadata.canOperateLocalPost ?? false,
      canHaveFoodMenus: metadata.canHaveFoodMenus ?? false,
      placeId: metadata.placeId ?? null,
      mapsUri: metadata.mapsUri ?? null,
      newReviewUri: metadata.newReviewUri ?? null,
    },
    // Every attribute Google offers this location, with its current value,
    // plus set ones Google no longer offers (deprecated).
    attributes: [
      ...available.map((entry) => ({
        name: entry.parent,
        displayName: entry.displayName ?? null,
        group: entry.groupDisplayName ?? null,
        valueType: entry.valueType ?? null,
        repeatable: entry.repeatable ?? false,
        value: attributeValue(currentByName.get(entry.parent)),
        ...(entry.valueType === "ENUM" || entry.valueType === "REPEATED_ENUM"
          ? { allowedValues: enumOptions(entry) }
          : {}),
      })),
      ...current
        .filter((entry) => !availableNames.has(entry.name))
        .map((entry) => ({
          name: entry.name,
          displayName: null,
          group: null,
          valueType: entry.valueType ?? null,
          repeatable: false,
          value: attributeValue(entry),
        })),
    ],
    recentPosts,
    foodMenu: menus ? summarizeFoodMenus(menus) : null,
  };
}

async function searchCategories(input: {
  projectId: string;
  query: string;
  languageCode: string;
  regionCode: string;
}) {
  await requireSelfHosted();
  const { client } = await connectedClient(input.projectId);
  return {
    categories: await client.searchCategories({
      query: input.query,
      languageCode: input.languageCode,
      regionCode: input.regionCode,
    }),
  };
}

/** Every Business Profile category in the region, read with the project's
 *  connection: Google's list is the same for any account. */
async function listCategories(input: {
  projectId: string;
  languageCode: string;
  regionCode: string;
}) {
  await requireSelfHosted();
  const { client } = await connectedClient(input.projectId);
  return client.listCategories({
    languageCode: input.languageCode,
    regionCode: input.regionCode,
  });
}

async function updateListing(
  input: LocationInput & { fields: ListingFields; apply: boolean },
): Promise<EditResult> {
  await requireSelfHosted();
  const { client, location } = await resolveLocation({ ...input, edit: true });
  const current = toListing(await client.getLocation(location.location));
  const { fields } = input;

  const before = {
    primaryCategory: current.primaryCategory?.name ?? null,
    additionalCategories: current.additionalCategories.map(
      (category) => category.name,
    ),
    description: current.description,
    websiteUri: current.websiteUri,
    primaryPhone: current.primaryPhone,
    additionalPhones: current.additionalPhones,
    regularHours: current.regularHours,
    specialHours: current.specialHours,
    // Only the types sent: the others are kept as they are.
    moreHours: (fields.moreHours ?? []).map(
      (entry) =>
        current.moreHours.find(
          (existing) => existing.hoursTypeId === entry.hoursTypeId,
        ) ?? { hoursTypeId: entry.hoursTypeId, periods: [] },
    ),
  };
  // Unsent fields keep their current value, so a category or phone pair is
  // always written whole, as Google requires.
  const after = {
    primaryCategory: fields.primaryCategory ?? before.primaryCategory,
    additionalCategories:
      fields.additionalCategories ?? before.additionalCategories,
    description:
      fields.description === undefined
        ? before.description
        : fields.description || null,
    websiteUri:
      fields.websiteUri === undefined
        ? before.websiteUri
        : fields.websiteUri || null,
    primaryPhone: fields.primaryPhone ?? before.primaryPhone,
    additionalPhones: fields.additionalPhones ?? before.additionalPhones,
    regularHours: fields.regularHours
      ? normalizeHours(fields.regularHours)
      : before.regularHours,
    specialHours: fields.specialHours
      ? sortSpecialHours(fields.specialHours)
      : before.specialHours,
    moreHours: (fields.moreHours ?? []).map((entry) => ({
      hoursTypeId: entry.hoursTypeId,
      periods: normalizeHours(entry.periods),
    })),
  };

  const changes = FIELD_MASKS.filter(
    ([field]) =>
      fields[field] !== undefined && !isDeepEqual(before[field], after[field]),
  ).map(([field]) => ({ field, before: before[field], after: after[field] }));
  const result = { ...where(location), changes };
  if (changes.length === 0) {
    return {
      ...result,
      mode: "unchanged",
      validatedBy: "openseo",
      revert: null,
    };
  }

  const changed = new Set(changes.map((change) => change.field));
  const masks = [
    ...new Set(
      FIELD_MASKS.filter(([field]) => changed.has(field)).map(
        ([, mask]) => mask,
      ),
    ),
  ];
  // Only masked fields go in the body; a masked field left out is cleared.
  const body: Record<string, unknown> = {};
  if (masks.includes("categories")) {
    body.categories = {
      ...(after.primaryCategory
        ? { primaryCategory: { name: after.primaryCategory } }
        : {}),
      additionalCategories: after.additionalCategories.map((name) => ({
        name,
      })),
    };
  }
  if (masks.includes("profile.description") && after.description) {
    body.profile = { description: after.description };
  }
  if (masks.includes("websiteUri") && after.websiteUri) {
    body.websiteUri = after.websiteUri;
  }
  if (masks.includes("phoneNumbers")) {
    body.phoneNumbers = {
      ...(after.primaryPhone ? { primaryPhone: after.primaryPhone } : {}),
      additionalPhones: after.additionalPhones,
    };
  }
  if (masks.includes("regularHours") && after.regularHours.length > 0) {
    body.regularHours = { periods: after.regularHours.map(toGooglePeriod) };
  }
  if (masks.includes("specialHours") && after.specialHours.length > 0) {
    body.specialHours = {
      specialHourPeriods: after.specialHours.map(toGoogleSpecial),
    };
  }
  if (masks.includes("moreHours")) {
    const sent = new Set(after.moreHours.map((entry) => entry.hoursTypeId));
    body.moreHours = [
      ...current.moreHours.filter((entry) => !sent.has(entry.hoursTypeId)),
      ...after.moreHours,
    ]
      .filter((entry) => entry.periods.length > 0)
      .map((entry) => ({
        hoursTypeId: entry.hoursTypeId,
        periods: entry.periods.map(toGooglePeriod),
      }));
  }

  await client.patchLocation({
    location: location.location,
    updateMask: masks,
    body,
    validateOnly: !input.apply,
  });
  if (!input.apply) {
    return { ...result, mode: "preview", validatedBy: "google", revert: null };
  }
  const revert: Record<string, unknown> = { location: location.location };
  for (const change of changes) {
    // "" is how the tool removes a description or website.
    if (change.before !== null) revert[change.field] = change.before;
    else if (change.field === "description" || change.field === "websiteUri") {
      revert[change.field] = "";
    }
  }
  return { ...result, mode: "applied", validatedBy: "google", revert };
}

async function updateAttributes(
  input: LocationInput & {
    attributes: Array<{ name: string; value: AttributeValue }>;
    apply: boolean;
  },
): Promise<EditResult> {
  await requireSelfHosted();
  const { client, location } = await resolveLocation({ ...input, edit: true });
  const [current, available] = await Promise.all([
    client.getAttributes(location.location),
    client.listAttributeMetadata(location.location),
  ]);
  const currentByName = new Map(current.map((entry) => [entry.name, entry]));
  const availableByName = new Map(
    available.map((entry) => [entry.parent, entry]),
  );

  const seen = new Set<string>();
  const changes: Array<{
    field: string;
    before: unknown;
    after: AttributeValue;
    valueType: string | undefined;
  }> = [];
  for (const { name, value: requested } of input.attributes) {
    const value = normalizeAttributeValue(requested);
    if (seen.has(name)) {
      throw new AppError("VALIDATION_ERROR", `${name} is listed twice.`);
    }
    seen.add(name);
    const metadata = availableByName.get(name);
    if (!metadata) {
      throw new AppError(
        "VALIDATION_ERROR",
        `${name} is not available for this location. Available: ${[...availableByName.keys()].join(", ") || "none"}.`,
      );
    }
    checkAttributeValue(metadata, value);
    const before = attributeValue(currentByName.get(name));
    if (!isDeepEqual(before, value)) {
      changes.push({
        field: name,
        before,
        after: value,
        valueType: metadata.valueType,
      });
    }
  }

  const result = {
    ...where(location),
    validatedBy: "openseo" as const,
    changes: changes.map(({ field, before, after }) => ({
      field,
      before,
      after,
    })),
  };
  if (changes.length === 0) {
    return { ...result, mode: "unchanged", revert: null };
  }
  if (!input.apply) return { ...result, mode: "preview", revert: null };
  await client.updateAttributes({
    location: location.location,
    attributeMask: changes.map((change) => change.field),
    attributes: changes.flatMap((change) =>
      change.after === null
        ? []
        : [toRawAttribute(change.field, change.valueType, change.after)],
    ),
  });
  return {
    ...result,
    mode: "applied",
    revert: {
      location: location.location,
      attributes: changes.map((change) => ({
        name: change.field,
        value: change.before,
      })),
    },
  };
}

export const GbpListingService = {
  getListing,
  searchCategories,
  listCategories,
  updateListing,
  updateAttributes,
};
