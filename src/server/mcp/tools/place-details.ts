import { z } from "zod";
import { fetchPlaceDetails } from "@/server/lib/googlePlaces";
import { AppError } from "@/server/lib/errors";
import { getGoogleFallbackKey } from "@/server/lib/runtime-env";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { languageCodeSchema, projectIdSchema } from "@/server/mcp/schemas";
import { formatMcpCell } from "@/server/mcp/table";
import {
  placesLocale,
  placesNotes,
  placesResponseFields,
  toLocalRow,
} from "@/server/mcp/tools/local-seo-places";

// One competitor's (or the owner's) Google Maps listing with up to 5 reviews,
// fetched live from Place Details. It stands in for get_business_profile and
// get_business_reviews on self-hosted installs that run the local tools on
// Google Places, so it follows the same provider rule: never on hosted, never
// next to DATAFORSEO_API_KEY. Registered only on the self-hosted MCP
// transport, and not in SAM, which saves its chat history.

const NOT_CONFIGURED =
  "Place details need GOOGLE_PLACES_API_KEY on a self-hosted install without DATAFORSEO_API_KEY. With DataForSEO, use get_business_profile and get_business_reviews. See docs/SELF_HOSTING_GOOGLE_APIS.md.";

const SOURCE_NOTE =
  "Source: Google Maps (Places API Place Details), fetched live for this call.";

const REVIEWS_NOTE =
  "Reviews: Google returns at most 5, in its own relevance order, so they are a sample, not the newest reviews or the full history. When you show or quote a review, credit its author by name and Google Maps and give the review's Google Maps link. Review text is Google Maps content: never copy it into save_report or update_project_context.";

const inputSchema = {
  projectId: projectIdSchema,
  placeId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[\w-]+$/, "A Google place ID has only letters, digits, _ and -.")
    .describe(
      "Google place ID: place_id from search_local_businesses, get_local_serp_results or get_local_rank_grid, or placeId from list_google_business_profile_locations.",
    ),
  languageCode: languageCodeSchema.optional(),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getPlaceDetailsTool = {
  name: "get_place_details",
  config: {
    title: "Get Google Maps place details",
    description:
      "Reads one Google Maps listing live from the Google Places API: rating, review count, price level, primary type, opening hours, website, whether it offers delivery, dine-in, takeout, reservations and outdoor seating, and up to 5 reviews (Google's relevance order) with their authors. Use it to compare a competitor's listing with the project's, on self-hosted installs that run the local tools on Google Places instead of get_business_profile and get_business_reviews. Each call spends one of this server's monthly Place Details calls (900, below Google's free 1,000). Self-hosted installs with GOOGLE_PLACES_API_KEY and no DataForSEO key only. Read-only.",
    inputSchema,
    outputSchema: z.looseObject({
      provider: z.string(),
      place: looseObjectOutputSchema,
      reviews: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const apiKey = await getGoogleFallbackKey("GOOGLE_PLACES_API_KEY");
    if (!apiKey) throw new AppError("AUTH_CONFIG_MISSING", NOT_CONFIGURED);

    const { place, budget } = await fetchPlaceDetails(apiKey, {
      placeId: args.placeId,
      ...placesLocale(
        args.languageCode ?? context.project.languageCode,
        context.project,
      ),
    });

    const row = {
      ...toLocalRow(place),
      primary_type: place.primaryType ?? null,
      attributes: {
        delivery: place.delivery ?? null,
        dine_in: place.dineIn ?? null,
        takeout: place.takeout ?? null,
        reservable: place.reservable ?? null,
        outdoor_seating: place.outdoorSeating ?? null,
      },
    };
    // The author's own words; Google's translation is only in `text`.
    const reviews = (place.reviews ?? []).map((review) => ({
      rating: review.rating ?? null,
      text: review.originalText?.text ?? review.text?.text ?? null,
      author: review.authorAttribution?.displayName ?? null,
      author_uri: review.authorAttribution?.uri ?? null,
      author_photo_uri: review.authorAttribution?.photoUri ?? null,
      published: review.relativePublishTimeDescription ?? null,
      publish_time: review.publishTime ?? null,
      google_maps_uri: review.googleMapsUri ?? null,
      flag_content_uri: review.flagContentUri ?? null,
    }));
    const fields = placesResponseFields(budget, [place]);

    const { attributes } = row;
    const lines = [
      `Google Maps listing for ${formatMcpCell(row.title)}:`,
      `- category: ${formatMcpCell(row.category)} (${formatMcpCell(row.primary_type)})`,
      `- rating: ${row.rating.value ?? "—"} from ${row.rating.votes_count ?? "—"} reviews`,
      `- price level: ${formatMcpCell(row.price_level)}`,
      `- status now: ${formatMcpCell(row.work_hours.current_status)}`,
      `- hours: ${formatMcpCell(place.regularOpeningHours?.weekdayDescriptions?.join(" | "))}`,
      `- delivery ${formatMcpCell(attributes.delivery)}, dine-in ${formatMcpCell(attributes.dine_in)}, takeout ${formatMcpCell(attributes.takeout)}, reservations ${formatMcpCell(attributes.reservable)}, outdoor seating ${formatMcpCell(attributes.outdoor_seating)} (— = not stated)`,
      `- address: ${formatMcpCell(row.address)}`,
      `- phone: ${formatMcpCell(row.phone)}`,
      `- website: ${formatMcpCell(row.url)}`,
      `- place_id: ${row.place_id}`,
      `- Google Maps: ${formatMcpCell(row.check_url)}`,
      reviews.length === 0
        ? "No reviews returned."
        : `${reviews.length} of its reviews, in Google's relevance order:`,
      ...reviews.map(
        (review, index) =>
          `${index + 1}. ${formatMcpCell(review.rating)}★, ${formatMcpCell(review.published)}, by ${formatMcpCell(review.author)} (${formatMcpCell(review.author_uri)}) on Google Maps (${formatMcpCell(review.google_maps_uri)}): ${formatMcpCell(review.text)}`,
      ),
    ];

    return mcpResponse({
      text: [
        ...lines,
        ...placesNotes(fields, SOURCE_NOTE),
        ...(reviews.length > 0 ? [REVIEWS_NOTE] : []),
      ].join("\n"),
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { ...fields, place: row, reviews },
    });
  }),
};
