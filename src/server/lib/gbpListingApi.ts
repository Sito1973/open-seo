import { sortBy } from "remeda";
import type { z } from "zod";
import {
  attributeMetadataResponseSchema,
  attributesSchema,
  categoriesResponseSchema,
  createdLocalPostSchema,
  foodMenusSchema,
  gbpLocationNameSchema,
  googleUpdatedSchema,
  listingLocationSchema,
  localPostsResponseSchema,
  type foodMenuSchema,
  type rawAttributeSchema,
} from "@/server/lib/gbpApiSchemas";
import { GbpApiError } from "@/server/lib/gbpErrors";
import {
  BUSINESS_INFO_API_BASE,
  collectPages,
  type GbpRequest,
  reviewUrl,
  V4_API_BASE,
  v4LocationName,
} from "@/server/lib/gbpRequest";

// The listing calls behind the Business Profile edit tools: the full profile,
// attributes, categories, review replies, posts and the food menu. Writes run
// only from GbpListingService and GbpContentService, which preview by
// default.

// The listing fields the edit tools read and compare. Address and name stay
// out: they are not editable here.
const LISTING_READ_MASK = [
  "name",
  "title",
  "categories",
  "profile",
  "regularHours",
  "specialHours",
  "moreHours",
  "websiteUri",
  "phoneNumbers",
  "openInfo",
  "serviceItems",
  "metadata",
].join(",");
const MAX_ATTRIBUTE_METADATA = 500;
// Google lists about 4,000 categories per region.
const MAX_CATEGORIES = 10_000;
const RECENT_POSTS = 10;
const POST_SUMMARY_PREVIEW = 200;

export type RawAttribute = z.infer<typeof rawAttributeSchema>;
export type RawFoodMenu = z.infer<typeof foodMenuSchema>;

const splitMask = (mask: string | undefined) =>
  (mask ?? "").split(",").filter(Boolean);

function categoriesUrl(input: { regionCode: string; languageCode: string }) {
  const url = new URL(`${BUSINESS_INFO_API_BASE}/categories`);
  url.searchParams.set("regionCode", input.regionCode);
  url.searchParams.set("languageCode", input.languageCode);
  url.searchParams.set("view", "BASIC");
  return url;
}

export function createGbpListingApi(request: GbpRequest) {
  const get = (url: URL | string) => request("GET", url);

  return {
    /** The listing's editable fields (or `readMask` alone). */
    async getLocation(location: string, readMask = LISTING_READ_MASK) {
      const url = new URL(
        `${BUSINESS_INFO_API_BASE}/${gbpLocationNameSchema.parse(location)}`,
      );
      url.searchParams.set("readMask", readMask);
      return listingLocationSchema.parse(await get(url));
    },

    /** Fields with edits awaiting Google's review, and fields Google changed. */
    async getGoogleUpdated(location: string) {
      const url = new URL(
        `${BUSINESS_INFO_API_BASE}/${gbpLocationNameSchema.parse(location)}:getGoogleUpdated`,
      );
      url.searchParams.set("readMask", LISTING_READ_MASK);
      const data = googleUpdatedSchema.parse(await get(url));
      return {
        pendingFields: splitMask(data.pendingMask),
        googleUpdatedFields: splitMask(data.diffMask),
      };
    },

    /** Writes the masked fields; a masked field left out of `body` is
     *  cleared. validateOnly checks the edit without saving it. */
    async patchLocation(input: {
      location: string;
      updateMask: string[];
      body: Record<string, unknown>;
      validateOnly: boolean;
    }): Promise<void> {
      const url = new URL(
        `${BUSINESS_INFO_API_BASE}/${gbpLocationNameSchema.parse(input.location)}`,
      );
      url.searchParams.set("updateMask", input.updateMask.join(","));
      if (input.validateOnly) url.searchParams.set("validateOnly", "true");
      await request("PATCH", url, input.body);
    },

    async getAttributes(location: string): Promise<RawAttribute[]> {
      const data = attributesSchema.parse(
        await get(
          `${BUSINESS_INFO_API_BASE}/${gbpLocationNameSchema.parse(location)}/attributes`,
        ),
      );
      return data.attributes ?? [];
    },

    /** The attributes Google offers this location, without deprecated ones
     *  (Google silently drops updates to those). */
    async listAttributeMetadata(location: string) {
      const parent = gbpLocationNameSchema.parse(location);
      const metadata = await collectPages(
        MAX_ATTRIBUTE_METADATA,
        async (pageToken) => {
          const url = new URL(`${BUSINESS_INFO_API_BASE}/attributes`);
          url.searchParams.set("parent", parent);
          url.searchParams.set("pageSize", "200");
          if (pageToken) url.searchParams.set("pageToken", pageToken);
          const page = attributeMetadataResponseSchema.parse(await get(url));
          return {
            items: page.attributeMetadata ?? [],
            nextPageToken: page.nextPageToken,
          };
        },
      );
      return metadata.filter((attribute) => !attribute.deprecated);
    },

    /** A name in `attributeMask` with no entry in `attributes` is removed. */
    async updateAttributes(input: {
      location: string;
      attributeMask: string[];
      attributes: RawAttribute[];
    }): Promise<void> {
      const location = gbpLocationNameSchema.parse(input.location);
      const url = new URL(`${BUSINESS_INFO_API_BASE}/${location}/attributes`);
      url.searchParams.set("attributeMask", input.attributeMask.join(","));
      await request("PATCH", url, {
        name: `${location}/attributes`,
        attributes: input.attributes,
      });
    },

    /** Google matches the start of the category's display name. */
    async searchCategories(input: {
      query: string;
      regionCode: string;
      languageCode: string;
    }) {
      const url = categoriesUrl(input);
      url.searchParams.set("filter", `displayName=${input.query}`);
      url.searchParams.set("pageSize", "25");
      const data = categoriesResponseSchema.parse(await get(url));
      return data.categories ?? [];
    },

    /** Every category Google offers businesses in the region. */
    async listCategories(input: { regionCode: string; languageCode: string }) {
      return collectPages(MAX_CATEGORIES, async (pageToken) => {
        const url = categoriesUrl(input);
        url.searchParams.set("pageSize", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const page = categoriesResponseSchema.parse(await get(url));
        return {
          items: page.categories ?? [],
          nextPageToken: page.nextPageToken,
        };
      });
    },

    async putReviewReply(input: {
      accountName: string;
      location: string;
      reviewId: string;
      comment: string;
    }): Promise<void> {
      await request("PUT", `${reviewUrl(input)}/reply`, {
        comment: input.comment,
      });
    },

    async deleteReviewReply(input: {
      accountName: string;
      location: string;
      reviewId: string;
    }): Promise<void> {
      await request("DELETE", `${reviewUrl(input)}/reply`);
    },

    /** The most recent posts, newest first (Google leaves the order open). */
    async listLocalPosts(input: { accountName: string; location: string }) {
      const url = new URL(`${V4_API_BASE}/${v4LocationName(input)}/localPosts`);
      url.searchParams.set("pageSize", String(RECENT_POSTS));
      const data = localPostsResponseSchema.parse(await get(url));
      const posts = (data.localPosts ?? []).map((post) => ({
        topicType: post.topicType ?? null,
        summary: post.summary?.slice(0, POST_SUMMARY_PREVIEW) ?? null,
        state: post.state ?? null,
        createTime: post.createTime ?? null,
        searchUrl: post.searchUrl ?? null,
      }));
      return sortBy(posts, [(post) => post.createTime ?? "", "desc"]);
    },

    async createLocalPost(input: {
      accountName: string;
      location: string;
      post: Record<string, unknown>;
    }) {
      const created = createdLocalPostSchema.parse(
        await request(
          "POST",
          `${V4_API_BASE}/${v4LocationName(input)}/localPosts`,
          input.post,
        ),
      );
      return {
        name: created.name,
        state: created.state ?? null,
        searchUrl: created.searchUrl ?? null,
      };
    },

    /** The raw menus, [] when the location has none yet. */
    async getFoodMenus(input: {
      accountName: string;
      location: string;
    }): Promise<RawFoodMenu[]> {
      try {
        const data = foodMenusSchema.parse(
          await get(`${V4_API_BASE}/${v4LocationName(input)}/foodMenus`),
        );
        return data.menus ?? [];
      } catch (error) {
        if (error instanceof GbpApiError && error.status === 404) return [];
        throw error;
      }
    },

    /** Replaces every menu: Google cannot update one item on its own. */
    async updateFoodMenus(input: {
      accountName: string;
      location: string;
      menus: RawFoodMenu[];
    }): Promise<void> {
      const name = `${v4LocationName(input)}/foodMenus`;
      const url = new URL(`${V4_API_BASE}/${name}`);
      url.searchParams.set("updateMask", "menus");
      await request("PATCH", url, { name, menus: input.menus });
    },
  };
}
