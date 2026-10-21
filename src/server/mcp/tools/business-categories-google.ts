import { z } from "zod";
import { GbpListingService } from "@/server/features/gbp/services/GbpListingService";
import {
  GbpApiError,
  GbpNotConnectedError,
  GbpTokenError,
} from "@/server/lib/gbpErrors";
import {
  isPlacesBusinessType,
  PLACES_BUSINESS_TYPES,
} from "@/server/lib/placesTypes";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { getIsoCountryCode } from "@/shared/keyword-locations";
import { foldLocationText } from "@/shared/serp-location-search";

// list_business_categories on a self-hosted install without DataForSEO.
// DataForSEO's category slugs are Google Business Profile category IDs, so
// with Business Profile connected the tool lists Google's own list, in the
// project's country and language. Otherwise it lists the Places types Text
// Search filters by. Neither source counts the businesses in a category.

// Google's category list, the same for every account, so one entry per
// country and language serves every project.
const GBP_CATEGORIES_CACHE_NAMESPACE = "local:gbp-business-categories";
const GBP_CATEGORIES_TTL_SECONDS = 30 * 24 * 60 * 60;

const cachedGbpCategoriesSchema = z
  .array(z.object({ category: z.string(), displayName: z.string() }))
  .min(1);

type CategorySource = {
  source: "google_business_profile" | "google_places_types";
  categories: { category: string; displayName: string | null }[];
  note: string;
};

type CategoryRow = {
  category: string;
  displayName: string | null;
  placesType: boolean;
  businessCount: null;
};

const CATEGORY_COLUMNS: McpTableColumn<CategoryRow>[] = [
  { header: "category", value: (row) => row.category },
  { header: "name", value: (row) => row.displayName },
  { header: "places type", value: (row) => row.placesType },
];

function searchText(value: string): string {
  return foldLocationText(value.replaceAll("_", " "));
}

export async function listGoogleBusinessCategories(
  args: { projectId: string; query?: string; limit?: number },
  context: {
    baseUrl: string;
    project: { locationCode: number; languageCode: string };
  },
) {
  const loaded = await loadCategories({
    projectId: args.projectId,
    regionCode: getIsoCountryCode(context.project.locationCode).toUpperCase(),
    languageCode: context.project.languageCode,
  });

  const query = args.query ? searchText(args.query) : null;
  const matched = query
    ? loaded.categories.filter((row) =>
        searchText(`${row.category} ${row.displayName ?? ""}`).includes(query),
      )
    : loaded.categories;
  const categories: CategoryRow[] = matched
    .slice(0, args.limit ?? 50)
    .map((row) => ({
      ...row,
      placesType: isPlacesBusinessType(row.category),
      businessCount: null,
    }));

  const header = `Found ${matched.length} categories${query ? ` matching "${args.query}"` : ""}; showing ${categories.length}.`;
  return mcpResponse({
    text: [
      header,
      loaded.note,
      "Pass a category to search_local_businesses. A category that is a Google Places type (places type: yes) filters the search to that type; any other adds its words to the text search. No business counts: only DataForSEO has them.",
      ...(categories.length > 0
        ? [formatMcpTable(categories, CATEGORY_COLUMNS)]
        : []),
    ].join("\n"),
    meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
    structuredContent: { categories, source: loaded.source },
  });
}

async function loadCategories(input: {
  projectId: string;
  regionCode: string;
  languageCode: string;
}): Promise<CategorySource> {
  const fromBusinessProfile = (
    categories: CategorySource["categories"],
  ): CategorySource => ({
    source: "google_business_profile",
    categories,
    note: `Google Business Profile categories for ${input.regionCode}, in ${input.languageCode}.`,
  });
  const cacheKey = await buildCacheKey(GBP_CATEGORIES_CACHE_NAMESPACE, {
    regionCode: input.regionCode,
    languageCode: input.languageCode,
  });
  const cached = cachedGbpCategoriesSchema.safeParse(await getCached(cacheKey));
  if (cached.success) return fromBusinessProfile(cached.data);

  let fallbackReason: string;
  try {
    const listed = await GbpListingService.listCategories(input);
    if (listed.length > 0) {
      const categories = listed.map((entry) => ({
        category: entry.name.replace(/^categories\/(gcid:)?/, ""),
        displayName: entry.displayName,
      }));
      await setCached(cacheKey, categories, GBP_CATEGORIES_TTL_SECONDS);
      return fromBusinessProfile(categories);
    }
    fallbackReason = `Business Profile listed no categories for ${input.regionCode} in ${input.languageCode}`;
  } catch (error) {
    if (
      !(
        error instanceof GbpNotConnectedError ||
        error instanceof GbpTokenError ||
        error instanceof GbpApiError
      )
    ) {
      throw error;
    }
    fallbackReason = error.message.replace(/\.$/, "");
  }
  return {
    source: "google_places_types",
    categories: PLACES_BUSINESS_TYPES.map((category) => ({
      category,
      displayName: null,
    })),
    note: `${fallbackReason}, so these are Google Places place types (English IDs). Connect Business Profile in the project's settings for Google's full category list in the project's language.`,
  };
}
