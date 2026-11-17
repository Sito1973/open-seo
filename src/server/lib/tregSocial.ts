import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { callTreg } from "@/server/lib/treg";

// The four treg catalog tools OpenSEO calls, each read into the fields its
// MCP tool returns. The three treg.* tools are routed: treg picks a provider
// and answers {output, raw}. `output` is treg's own contract, the same from
// every provider, so only it is read. The Meta Ad Library tool answers in its
// provider's own format.

// A field a provider leaves out, or sends in another type, reads as null: one
// odd field must not fail a call that is already paid for.
const text = z
  .string()
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);
const count = z
  .number()
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);
const flag = z
  .boolean()
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);
/** An id a provider may send as a number. */
const idText = z
  .union([z.string(), z.number()])
  .nullish()
  .catch(null)
  .transform((value) => (value == null ? null : String(value)));
const textList = z
  .array(z.string())
  .nullish()
  .catch(null)
  .transform((value) => value ?? []);

const RESERVED_INSTAGRAM_PATHS = new Set([
  "p",
  "reel",
  "reels",
  "explore",
  "stories",
  "tv",
]);

/**
 * An Instagram handle from "handle", "@handle" or a profile URL. Handles are
 * 1-30 letters, digits, dots and underscores, and never case-sensitive.
 */
export function parseInstagramUsername(input: string): string {
  const trimmed = input.trim();
  const fromUrl = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)/i.exec(
    trimmed,
  )?.[1];
  const username = (fromUrl ?? trimmed).replace(/^@/, "").toLowerCase();
  if (
    !/^[a-z0-9._]{1,30}$/.test(username) ||
    (fromUrl && RESERVED_INSTAGRAM_PATHS.has(username))
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `"${trimmed.slice(0, 80)}" is not an Instagram handle. Pass the handle (bandidos_restaurante), with or without @, or the profile URL. search_instagram_accounts finds a business's handle.`,
    );
  }
  return username;
}

const profileUrl = (username: string) =>
  `https://www.instagram.com/${username}/`;

const profileSchema = z.object({
  output: z.object({
    username: text,
    user_id: idText,
    full_name: text,
    followers: count,
    following: count,
    posts_count: count,
    is_verified: flag,
    is_private: flag,
    biography: text,
  }),
});

/** One public Instagram profile, or null when no provider found the account. */
export async function fetchInstagramProfile(apiKey: string, username: string) {
  const { data, charge } = await callTreg(apiKey, {
    tool: "treg.instagram.user.profile",
    body: { username },
    schema: profileSchema,
  });
  const found = data.output;
  return {
    charge,
    // treg answers an account it could not find with a null username.
    profile: found.username
      ? {
          username: found.username,
          url: profileUrl(found.username),
          userId: found.user_id,
          fullName: found.full_name,
          followers: found.followers,
          following: found.following,
          postsCount: found.posts_count,
          isVerified: found.is_verified,
          isPrivate: found.is_private,
          biography: found.biography,
        }
      : null,
  };
}

const postsSchema = z.object({
  output: z.object({
    posts: z.array(
      z.object({
        code: text,
        url: text,
        kind: text,
        caption: text,
        likes: count,
        comments: count,
        taken_at: text,
        owner: text,
        image: text,
        video_url: text,
      }),
    ),
  }),
});

/**
 * A public account's most recent posts (12 from the providers seen so far),
 * newest first as the provider lists them. `imageUrl` and `videoUrl` expire
 * within hours or days: download what must be kept during the same call.
 */
export async function fetchInstagramPosts(apiKey: string, username: string) {
  const { data, charge } = await callTreg(apiKey, {
    tool: "treg.instagram.user.posts",
    body: { username },
    schema: postsSchema,
  });
  return {
    charge,
    posts: data.output.posts.map((post) => ({
      code: post.code,
      url: post.url,
      kind: post.kind,
      caption: post.caption,
      likes: post.likes,
      comments: post.comments,
      takenAt: post.taken_at,
      // On a collaboration the post belongs to another account.
      owner: post.owner,
      isCollaboration:
        post.owner != null && post.owner.toLowerCase() !== username,
      imageUrl: post.image,
      videoUrl: post.video_url,
    })),
  };
}

const searchSchema = z.object({
  output: z.object({
    users: z.array(
      z.object({
        username: text,
        full_name: text,
        url: text,
        follower_count: count,
        following_count: count,
        media_count: count,
        biography: text,
        external_url: text,
        is_verified: flag,
        is_private: flag,
        matched_from: text,
      }),
    ),
  }),
});

/**
 * Instagram accounts whose name or bio match the words. Every provider of
 * this search bills a miss, so only the first one is paid.
 */
export async function searchInstagramAccounts(apiKey: string, query: string) {
  const { data, charge } = await callTreg(apiKey, {
    tool: "treg.instagram.search.users",
    body: { q: query },
    schema: searchSchema,
    singleProvider: true,
  });
  return {
    charge,
    accounts: data.output.users.flatMap((user) =>
      user.username
        ? [
            {
              username: user.username,
              url: user.url ?? profileUrl(user.username),
              fullName: user.full_name,
              // Rows found on directory pages carry no counts.
              followers: user.follower_count,
              following: user.following_count,
              postsCount: user.media_count,
              biography: user.biography,
              externalUrl: user.external_url,
              isVerified: user.is_verified,
              isPrivate: user.is_private,
              matchedFrom: user.matched_from,
            },
          ]
        : [],
    ),
  };
}

const adsSchema = z.object({
  // The provider's notes: which page a name or URL matched, or that none did.
  meta: z.object({ warnings: textList }).nullish().catch(null),
  rows: z.array(
    z.object({
      ad_archive_id: idText,
      ad_url: text,
      page_id: idText,
      page_name: text,
      page_url: text,
      page_likes: count,
      title: text,
      body: text,
      cta: text,
      link_url: text,
      link_caption: text,
      display_format: text,
      start_date: text,
      end_date: text,
      is_active: flag,
      platforms: textList,
      same_creative_ads: count,
      images: textList,
      videos: textList,
      cards: z
        .array(
          z.object({
            title: text,
            body: text,
            cta: text,
            link_url: text,
            image: text,
            video: text,
          }),
        )
        .nullish()
        .catch(null)
        .transform((value) => value ?? []),
    }),
  ),
});

/**
 * The ads one Facebook page runs now in a country, from the Meta Ad Library.
 * `page` is the page's numeric id, its Facebook URL, or a name, which can
 * match another page with the same name: `providerNotes` says which page was
 * read. A call that finds no ads is free. Media links expire within hours or
 * days.
 */
export async function fetchMetaPageAds(
  apiKey: string,
  input: { page: string; country: string; limit: number },
) {
  const { data, charge } = await callTreg(apiKey, {
    tool: "crawl4ai.meta-ads.library.advertiser",
    body: {
      page: input.page,
      country: input.country,
      active_status: "active",
      limit: input.limit,
    },
    schema: adsSchema,
  });
  return {
    charge,
    providerNotes: (data.meta?.warnings ?? []).map((note) =>
      note.replace(/^module: [\w-]+: /, ""),
    ),
    ads: data.rows.map((ad) => ({
      adArchiveId: ad.ad_archive_id,
      adUrl: ad.ad_url,
      pageId: ad.page_id,
      pageName: ad.page_name,
      pageUrl: ad.page_url,
      pageLikes: ad.page_likes,
      title: ad.title,
      body: ad.body,
      cta: ad.cta,
      linkUrl: ad.link_url,
      linkCaption: ad.link_caption,
      displayFormat: ad.display_format,
      startDate: ad.start_date,
      endDate: ad.end_date,
      isActive: ad.is_active,
      platforms: ad.platforms,
      sameCreativeAds: ad.same_creative_ads,
      // A carousel or dynamic ad keeps its media on its cards, and some
      // list it in both places.
      imageUrls: [
        ...new Set([
          ...ad.images,
          ...ad.cards.flatMap((card) => (card.image ? [card.image] : [])),
        ]),
      ],
      videoCount:
        ad.videos.length || ad.cards.filter((card) => card.video).length,
      cards: ad.cards.map((card) => ({
        title: card.title,
        body: card.body,
        cta: card.cta,
        linkUrl: card.link_url,
      })),
    })),
  };
}
