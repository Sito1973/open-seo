import { omit } from "remeda";
import { z } from "zod";
import {
  fetchInstagramPosts,
  fetchInstagramProfile,
  parseInstagramUsername,
  searchInstagramAccounts,
} from "@/server/lib/tregSocial";
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

// A competitor's public Instagram, read live through treg: OpenSEO has no
// other source for it. See treg-shared.ts for where these tools run.

const SOURCE_NOTE =
  "Source: public Instagram data through treg (treg.to), fetched live for this call.";

const ANNOTATIONS = {
  // Each call spends the owner's treg balance, like a credit-charging tool.
  readOnlyHint: false,
  openWorldHint: true,
  destructiveHint: false,
} as const;

const DAY_MS = 86_400_000;
const MAX_POST_IMAGES = 12;
const DEFAULT_POST_IMAGES = 6;

const usernameSchema = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "The account's Instagram handle, with or without @, or its profile URL: bandidos_restaurante. Not a business name: search_instagram_accounts finds the handle.",
  );

const count = (value: number | null) =>
  value == null ? "—" : formatCount(value);

const profileInputSchema = {
  projectId: projectIdSchema,
  username: usernameSchema,
} as const;

export const getInstagramProfileTool = {
  name: "get_instagram_profile",
  config: {
    title: "Get Instagram profile",
    description: `Reads one public Instagram account live through treg: followers, following, number of posts, verified and private flags, full name and bio. Use it to size a competitor's Instagram against the project's own account; get_instagram_posts adds what they post and how it performs. found is false when no provider could find the account, which treg can still bill. ${UNTRUSTED_TEXT_NOTE} About $0.001 a call. ${TREG_COST_NOTE}`,
    inputSchema: profileInputSchema,
    outputSchema: z.looseObject({
      ...tregOutputFields,
      username: z.string(),
      found: z.boolean(),
      profile: looseObjectOutputSchema.nullable(),
    }),
    annotations: ANNOTATIONS,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof profileInputSchema>>, context) => {
      const apiKey = await requireTregKey();
      const username = parseInstagramUsername(args.username);
      const { profile, charge } = await fetchInstagramProfile(apiKey, username);
      const { fields, notes } = tregAnswer(charge, SOURCE_NOTE);

      const lines = profile
        ? [
            `Instagram profile of @${profile.username} (${formatMcpCell(profile.fullName)}):`,
            `- followers: ${count(profile.followers)}`,
            `- following: ${count(profile.following)}`,
            `- posts: ${count(profile.postsCount)}`,
            `- verified: ${formatMcpCell(profile.isVerified)}, private: ${formatMcpCell(profile.isPrivate)}`,
            `- bio: ${formatMcpCell(profile.biography)}`,
            `- ${profile.url}`,
          ]
        : [
            `No provider found an Instagram account @${username}. Check the handle, or find it with search_instagram_accounts.`,
          ];

      return mcpResponse({
        text: [...lines, ...notes].join("\n"),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: {
          ...fields,
          username,
          found: profile !== null,
          profile,
        },
      });
    },
  ),
};

const postsInputSchema = {
  projectId: projectIdSchema,
  username: usernameSchema,
  images: z
    .number()
    .int()
    .min(0)
    .max(MAX_POST_IMAGES)
    .optional()
    .describe(
      `How many of the newest posts get their image attached (a reel's cover), 0 to ${MAX_POST_IMAGES}. Default ${DEFAULT_POST_IMAGES}. Attaching images costs nothing more.`,
    ),
} as const;

type Post = Awaited<ReturnType<typeof fetchInstagramPosts>>["posts"][number];

const average = (values: Array<number | null>) => {
  // A hidden like count comes back null or negative.
  const known = values.flatMap((value) =>
    value != null && value >= 0 ? [value] : [],
  );
  return known.length === 0
    ? null
    : Math.round(known.reduce((sum, value) => sum + value, 0) / known.length);
};

function summarizePosts(posts: Post[], now: number) {
  const times = posts
    .map((post) => (post.takenAt ? Date.parse(post.takenAt) : Number.NaN))
    .filter((time) => Number.isFinite(time));
  const newest = times.length > 0 ? Math.max(...times) : null;
  const oldest = times.length > 0 ? Math.min(...times) : null;
  const kinds: Record<string, number> = {};
  for (const post of posts) {
    const kind = post.kind ?? "unknown";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return {
    posts: posts.length,
    newest: newest == null ? null : new Date(newest).toISOString(),
    oldest: oldest == null ? null : new Date(oldest).toISOString(),
    daysSinceNewest:
      newest == null ? null : Math.max(0, Math.floor((now - newest) / DAY_MS)),
    postsLast30Days: times.filter((time) => now - time <= 30 * DAY_MS).length,
    averageLikes: average(posts.map((post) => post.likes)),
    averageComments: average(posts.map((post) => post.comments)),
    kinds,
    collaborations: posts.filter((post) => post.isCollaboration).length,
  };
}

export const getInstagramPostsTool = {
  name: "get_instagram_posts",
  config: {
    title: "Get Instagram posts",
    description: `Lists a public Instagram account's most recent posts (12) live through treg: caption, type (photo, reel or carousel), likes, comments, date, link and, on a collaboration, the account that owns the post. Attaches the image of the newest posts (a reel's cover), downloaded during the call because Instagram's image links expire within hours, so you can see what they publish: images sets how many, and a post's image field is the position of its image among those attached, from 1. summary gives the averages and the pace over the posts returned: divide average likes and comments by the followers from get_instagram_profile for an engagement rate. Captions come cut to about 500 characters. A private account, or one with no posts, returns none. ${UNTRUSTED_TEXT_NOTE} About $0.001 a call. ${TREG_COST_NOTE}`,
    inputSchema: postsInputSchema,
    outputSchema: z.looseObject({
      ...tregOutputFields,
      username: z.string(),
      summary: looseObjectOutputSchema,
      posts: z.array(looseObjectOutputSchema),
      imagesAttached: z.number(),
    }),
    annotations: ANNOTATIONS,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof postsInputSchema>>, context) => {
      const apiKey = await requireTregKey();
      const username = parseInstagramUsername(args.username);
      const { posts, charge } = await fetchInstagramPosts(apiKey, username);
      const { fields, notes } = tregAnswer(charge, SOURCE_NOTE);

      const wanted = args.images ?? DEFAULT_POST_IMAGES;
      const { blocks, numbers } = await attachImages(
        posts
          .flatMap((post, index) =>
            post.imageUrl ? [{ index, url: post.imageUrl }] : [],
          )
          .slice(0, wanted),
      );
      // The media links expire, so the answer carries the images, not links.
      const rows = posts.map((post, index) => ({
        ...omit(post, ["imageUrl", "videoUrl"]),
        hasVideo: post.videoUrl != null,
        image: numbers.get(index) ?? null,
      }));
      const summary = summarizePosts(posts, Date.now());

      const lines =
        rows.length === 0
          ? [
              `No posts returned for @${username}: the account has none, is private, or no provider could read it.`,
            ]
          : [
              `${plural(rows.length, "most recent post")} of @${username}: ${summary.postsLast30Days} in the last 30 days, the newest ${formatMcpCell(summary.daysSinceNewest)} days ago; average ${count(summary.averageLikes)} likes and ${count(summary.averageComments)} comments; ${Object.entries(
                summary.kinds,
              )
                .map(([kind, total]) => `${total} ${kind}`)
                .join(
                  ", ",
                )}; ${summary.collaborations} posted with another account.`,
              formatMcpTable(rows, [
                { header: "date", value: (row) => row.takenAt?.slice(0, 10) },
                { header: "type", value: (row) => row.kind },
                { header: "likes", value: (row) => row.likes },
                { header: "comments", value: (row) => row.comments },
                {
                  header: "owner",
                  value: (row) => (row.isCollaboration ? row.owner : null),
                },
                {
                  header: "image",
                  value: (row) => (row.image ? `#${row.image}` : null),
                },
                { header: "url", value: (row) => row.url },
                {
                  header: "caption",
                  value: (row) => row.caption,
                  format: accountText(160),
                },
              ]),
              `${blocks.length > 0 ? imagesLine(blocks.length) : "No images attached."} owner is filled only when the post belongs to another account (a collaboration).`,
            ];

      const result = mcpResponse({
        text: [...lines, ...notes].join("\n"),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: {
          ...fields,
          username,
          summary,
          posts: rows,
          imagesAttached: blocks.length,
        },
      });
      result.content.push(...blocks);
      return result;
    },
  ),
};

const searchInputSchema = {
  projectId: projectIdSchema,
  query: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .describe(
      "The business name as people write it, plus its city when the name is common: Big Burguer Pereira.",
    ),
} as const;

export const searchInstagramAccountsTool = {
  name: "search_instagram_accounts",
  config: {
    title: "Search Instagram accounts",
    description: `Finds Instagram accounts by a business name or keywords through treg, to get a competitor's handle before get_instagram_profile and get_instagram_posts: "Big Burguer Pereira" finds @bigburguer.co. Returns each handle with its name and, when the provider gives them, followers, number of posts and bio. Check the name and the bio before trusting a match: businesses share names across cities, and a row without followers was found on a directory page, so confirm it with get_instagram_profile. ${UNTRUSTED_TEXT_NOTE} About $0.002 a call, billed even when nothing matches. ${TREG_COST_NOTE}`,
    inputSchema: searchInputSchema,
    outputSchema: z.looseObject({
      ...tregOutputFields,
      query: z.string(),
      accounts: z.array(looseObjectOutputSchema),
    }),
    annotations: ANNOTATIONS,
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof searchInputSchema>>, context) => {
      const apiKey = await requireTregKey();
      const { accounts, charge } = await searchInstagramAccounts(
        apiKey,
        args.query,
      );
      const { fields, notes } = tregAnswer(charge, SOURCE_NOTE);

      const lines =
        accounts.length === 0
          ? [
              `No Instagram account matched "${args.query}". Try the name as the business writes it, or add or drop the city.`,
            ]
          : [
              `${plural(accounts.length, "Instagram account")} matched "${args.query}":`,
              formatMcpTable(accounts, [
                { header: "handle", value: (row) => `@${row.username}` },
                {
                  header: "name",
                  value: (row) => row.fullName,
                  format: accountText(80),
                },
                { header: "followers", value: (row) => row.followers },
                { header: "posts", value: (row) => row.postsCount },
                { header: "verified", value: (row) => row.isVerified },
                {
                  header: "bio",
                  value: (row) => row.biography,
                  format: accountText(120),
                },
                { header: "url", value: (row) => row.url },
              ]),
            ];

      return mcpResponse({
        text: [...lines, ...notes].join("\n"),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { ...fields, query: args.query, accounts },
      });
    },
  ),
};
