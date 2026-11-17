import { omit } from "remeda";
import { z } from "zod";
import { fetchMetaPageAds } from "@/server/lib/tregSocial";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { looseObjectOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { formatMcpCell, formatMcpTable } from "@/server/mcp/table";
import {
  TREG_COST_NOTE,
  UNTRUSTED_TEXT_NOTE,
  accountText,
  attachImages,
  imagesLine,
  plural,
  requireTregKey,
  tregAnswer,
  tregOutputFields,
} from "@/server/mcp/tools/treg-shared";
import { formatCount } from "@/shared/format";
import { getIsoCountryCode } from "@/shared/keyword-locations";

// The ads a competitor's Facebook page runs now, from the Meta Ad Library
// through treg. Meta's official Ad Library API lists only political and
// social-issue ads outside the EU and UK, so OpenSEO has no other source for
// a commercial advertiser's ads there. See treg-shared.ts for where it runs.

const SOURCE_NOTE =
  "Source: Meta Ad Library through treg (treg.to), fetched live for this call.";

const NO_ADS_NOTE =
  "No ads found is not proof the page runs none: this source has missed pages with live ads, and a name can match another page with the same name.";

const DEFAULT_ADS = 10;
const MAX_ADS = 30;
const DEFAULT_AD_IMAGES = 4;
const MAX_AD_IMAGES = 10;

const inputSchema = {
  projectId: projectIdSchema,
  page: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      "The Facebook page to read: its numeric page ID (most reliable) or its Facebook URL (https://www.facebook.com/RappiColombia). A page name or the business's web domain also works, but either can match another page, in any country.",
    ),
  country: z
    .string()
    .regex(/^([A-Za-z]{2}|ALL)$/, "Two letters, such as CO, or ALL.")
    .optional()
    .describe(
      "Where the ads run: a two-letter country code, or ALL. Default: the project's country.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ADS)
    .optional()
    .describe(
      `Ads to return, 1 to ${MAX_ADS}. Default ${DEFAULT_ADS}. The source does not count a page's ads: limitReached in the answer says when the page may run more.`,
    ),
  images: z
    .number()
    .int()
    .min(0)
    .max(MAX_AD_IMAGES)
    .optional()
    .describe(
      `How many ads get their image attached, 0 to ${MAX_AD_IMAGES}, starting with the first that has one. Default ${DEFAULT_AD_IMAGES}. A video ad has no image to attach.`,
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

/** The page's own view in the Meta Ad Library, for a person to check. */
function adLibraryUrl(pageId: string, country: string): string {
  const url = new URL("https://www.facebook.com/ads/library/");
  url.searchParams.set("active_status", "active");
  url.searchParams.set("ad_type", "all");
  url.searchParams.set("country", country);
  url.searchParams.set("view_all_page_id", pageId);
  return url.toString();
}

export const getMetaAdLibraryAdsTool = {
  name: "get_meta_ad_library_ads",
  config: {
    title: "Get a Facebook page's active ads",
    description: `Lists the ads a Facebook page is running now across Meta's apps (Facebook, Instagram, Messenger, WhatsApp, Threads), from the Meta Ad Library through treg: headline, text, call to action, link, start date, platforms and format, for the project's country unless country says otherwise. Use it to see whether and how a competitor advertises. Always tell the user which page was read: pageUsed and providerNotes say it. ${NO_ADS_NOTE} When it matters, give the user adLibraryUrl to check in Meta's own library. Attaches the image of the first ads that have one (a video ad has none), downloaded during the call because the links expire: an ad's image field is the position of its image among those attached, from 1. ${UNTRUSTED_TEXT_NOTE} About $0.002 a call that finds ads; a call that finds none is free. ${TREG_COST_NOTE}`,
    inputSchema,
    outputSchema: z.looseObject({
      ...tregOutputFields,
      page: z.string(),
      country: z.string(),
      pageUsed: looseObjectOutputSchema.nullable(),
      providerNotes: z.array(z.string()),
      adLibraryUrl: z.string().nullable(),
      ads: z.array(looseObjectOutputSchema),
      limitReached: z.boolean(),
      imagesAttached: z.number(),
    }),
    annotations: {
      // Each call that finds ads spends the owner's treg balance.
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const apiKey = await requireTregKey();
    const country = (
      args.country ?? getIsoCountryCode(context.project.locationCode)
    ).toUpperCase();
    const limit = args.limit ?? DEFAULT_ADS;
    const { ads, providerNotes, charge } = await fetchMetaPageAds(apiKey, {
      page: args.page,
      country,
      limit,
    });
    // The source returns up to `limit` ads and never the page's total.
    const limitReached = ads.length >= limit;
    const { fields, notes } = tregAnswer(charge, SOURCE_NOTE);

    // An ad names its page. With no ads, the page's ID is the one the
    // provider's notes give ("… is the page X (id 123)", "page 123 has no
    // active ads"), or a numeric input.
    const first = ads[0];
    const noted = providerNotes
      .map((note) => /\(id (\d{5,})\)|^page (\d{5,})\b/.exec(note))
      .find((match) => match !== null);
    const pageId =
      first?.pageId ??
      noted?.[1] ??
      noted?.[2] ??
      (/^\d+$/.test(args.page) ? args.page : null);
    const pageUsed = pageId
      ? {
          id: pageId,
          name: first?.pageName ?? null,
          url: first?.pageUrl ?? null,
          likes: first?.pageLikes ?? null,
        }
      : null;
    const libraryUrl = pageId ? adLibraryUrl(pageId, country) : null;

    // The first ads that have an image: a video ad has none to attach.
    const wantedImages = args.images ?? DEFAULT_AD_IMAGES;
    const { blocks, numbers } = await attachImages(
      ads
        .flatMap((ad, index) => {
          const url = ad.imageUrls[0];
          return url ? [{ index, url }] : [];
        })
        .slice(0, wantedImages),
    );
    // The media links expire, so the answer carries the images, not links.
    const rows = ads.map((ad, index) => ({
      ...omit(ad, ["imageUrls", "pageId", "pageName", "pageUrl", "pageLikes"]),
      image: numbers.get(index) ?? null,
    }));

    const noteLines = providerNotes.map((note) => `Provider note: ${note}`);
    const lines =
      rows.length === 0
        ? [
            `No active ads found in ${country} for "${args.page}"${pageId ? ` (page ID ${pageId})` : ""}. ${NO_ADS_NOTE}`,
            ...noteLines,
            libraryUrl
              ? `Check in the Meta Ad Library: ${libraryUrl}`
              : "The provider did not say which page it read: pass the page's numeric ID or its Facebook URL.",
          ]
        : [
            `${plural(rows.length, "active ad")} in ${country} from the Facebook page ${formatMcpCell(pageUsed?.name)} (page ID ${formatMcpCell(pageUsed?.id)}, ${pageUsed?.likes == null ? "—" : formatCount(pageUsed.likes)} likes, ${formatMcpCell(pageUsed?.url)}):`,
            ...noteLines,
            formatMcpTable(rows, [
              {
                header: "started",
                value: (row) => row.startDate?.slice(0, 10),
              },
              { header: "format", value: (row) => row.displayFormat },
              {
                header: "platforms",
                value: (row) => row.platforms.join(", "),
              },
              { header: "cta", value: (row) => row.cta },
              {
                header: "title",
                value: (row) => row.title,
                format: accountText(80),
              },
              {
                header: "text",
                value: (row) => row.body,
                format: accountText(200),
              },
              { header: "link", value: (row) => row.linkUrl },
              { header: "videos", value: (row) => row.videoCount },
              {
                header: "image",
                value: (row) => (row.image ? `#${row.image}` : null),
              },
              { header: "ad", value: (row) => row.adUrl },
            ]),
            blocks.length > 0 ? imagesLine(blocks.length) : "",
            blocks.length === 0 && wantedImages > 0
              ? "No images attached: these ads have none, or their links no longer answer."
              : "",
            limitReached
              ? `The page may run more ads than these: the answer stops at limit, ${limit} here and ${MAX_ADS} at most.`
              : "",
            libraryUrl ? `The page in the Meta Ad Library: ${libraryUrl}` : "",
          ].filter(Boolean);

    const result = mcpResponse({
      text: [...lines, ...notes].join("\n"),
      meta: buildProjectMeta(context, args.projectId),
      structuredContent: {
        ...fields,
        page: args.page,
        country,
        pageUsed,
        providerNotes,
        adLibraryUrl: libraryUrl,
        ads: rows,
        limitReached,
        imagesAttached: blocks.length,
      },
    });
    result.content.push(...blocks);
    return result;
  }),
};
