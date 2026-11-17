import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getInstagramPostsTool,
  getInstagramProfileTool,
  searchInstagramAccountsTool,
} from "./instagram-tools";
import { makeToolContext, textContent } from "./tool-test-support";
import {
  answerWith,
  sentRequests,
  setUpTregInstall,
  tregResponse,
} from "./treg-test-support";

// The Instagram tools on a self-hosted install with TREG_API_KEY, and what
// every treg tool shares: each call carries a cost ceiling, is reserved from
// the monthly budget in US dollars before it is sent, and is corrected to
// what treg charged.

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  reserveCalls: vi.fn(),
  adjustCalls: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/google-places/repositories/GooglePlacesUsageRepository",
  () => ({
    GooglePlacesUsageRepository: {
      reserveCalls: mocks.reserveCalls,
      adjustCalls: mocks.adjustCalls,
    },
  }),
);

const toolContext = makeToolContext();
const profileArgs = {
  projectId: "project_1",
  username: "bandidos_restaurante",
};
const PROFILE_URL = "https://treg.to/call/treg.instagram.user.profile";
const POSTS_URL = "https://treg.to/call/treg.instagram.user.posts";
const SEARCH_URL = "https://treg.to/call/treg.instagram.search.users";

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();
const postImage = (name: string) => `https://scontent.cdninstagram.com/${name}`;

beforeEach(() => setUpTregInstall(mocks));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("sends the cost ceiling, reserves it from the monthly budget and corrects it to what treg charged", async () => {
  answerWith(mocks.fetch, {
    [PROFILE_URL]: () =>
      tregResponse(
        {
          output: {
            username: "bandidos_restaurante",
            full_name: "Bandidos Restaurante",
            followers: 11134,
          },
        },
        840,
      ),
  });

  const result = await getInstagramProfileTool.handler(
    {
      projectId: "project_1",
      username: "https://www.instagram.com/Bandidos_Restaurante/",
    },
    toolContext,
  );

  expect(mocks.reserveCalls).toHaveBeenCalledWith(
    expect.objectContaining({
      sku: "treg_usd_micro",
      count: 10_000,
      limit: 2_000_000,
    }),
  );
  expect(sentRequests(mocks.fetch)).toEqual([
    expect.objectContaining({
      url: PROFILE_URL,
      token: "treg-key",
      maxCost: "0.01",
      waterfall: null,
      body: { username: "bandidos_restaurante" },
    }),
  ]);
  expect(mocks.adjustCalls).toHaveBeenCalledWith(
    expect.objectContaining({ sku: "treg_usd_micro", delta: -9_160 }),
  );
  expect(result.structuredContent).toMatchObject({
    found: true,
    profile: {
      username: "bandidos_restaurante",
      url: "https://www.instagram.com/bandidos_restaurante/",
      followers: 11134,
      following: null,
    },
    treg: { chargedUsd: 0.00084, budget: { usedUsd: 0.50084, limitUsd: 2 } },
  });
  expect(textContent(result)).toContain(
    "treg charged $0.00084 for this call. treg budget: $0.50084 of $2.00 used this month",
  );
});

it("reports an account no provider found, which treg can still bill", async () => {
  answerWith(mocks.fetch, {
    [PROFILE_URL]: () => tregResponse({ output: { username: null } }, 840),
  });

  const result = await getInstagramProfileTool.handler(
    profileArgs,
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({
    found: false,
    profile: null,
    treg: { chargedUsd: 0.00084 },
  });
});

it.each([
  {
    case: "treg is not configured",
    setup: () => vi.stubEnv("TREG_API_KEY", ""),
    code: "PROVIDER_NOT_CONFIGURED",
    reason: "treg is not configured on this server",
  },
  {
    case: "the install is hosted",
    setup: () => vi.stubEnv("AUTH_MODE", "hosted"),
    code: "PROVIDER_NOT_CONFIGURED",
    reason: "treg is not configured on this server",
  },
  {
    case: "the monthly budget setting is not an amount",
    setup: () => vi.stubEnv("TREG_MONTHLY_BUDGET_USD", "2,5"),
    code: "PROVIDER_NOT_CONFIGURED",
    reason: "TREG_MONTHLY_BUDGET_USD is not an amount",
  },
  {
    case: "the monthly budget is used up",
    setup: () => mocks.reserveCalls.mockResolvedValue(null),
    code: "MONTHLY_BUDGET_EXHAUSTED",
    reason: "monthly treg budget ($2.00 in",
  },
])("sends nothing when $case", async ({ setup, code, reason }) => {
  setup();

  const call = getInstagramProfileTool.handler(profileArgs, toolContext);

  await expect(call).rejects.toMatchObject({ code });
  // Each refusal says why, so the owner knows what to fix.
  await expect(call).rejects.toThrow(reason);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("refuses a business name as a handle before anything is reserved", async () => {
  await expect(
    getInstagramProfileTool.handler(
      { projectId: "project_1", username: "Big Burguer Pereira" },
      toolContext,
    ),
  ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(mocks.reserveCalls).not.toHaveBeenCalled();
});

it("gives the whole reservation back when treg refuses a call, which it does not bill", async () => {
  answerWith(mocks.fetch, {
    [PROFILE_URL]: () =>
      Response.json(
        { detail: { error: "insufficient_balance", message: "Top up." } },
        { status: 402 },
      ),
  });

  await expect(
    getInstagramProfileTool.handler(profileArgs, toolContext),
  ).rejects.toMatchObject({ code: "TREG_BILLING_ISSUE" });
  expect(mocks.adjustCalls).toHaveBeenCalledWith(
    expect.objectContaining({ delta: -10_000 }),
  );
});

it("keeps the whole ceiling counted when treg's answer is lost", async () => {
  mocks.fetch.mockRejectedValue(new DOMException("timed out", "TimeoutError"));

  await expect(
    getInstagramProfileTool.handler(profileArgs, toolContext),
  ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  expect(mocks.adjustCalls).not.toHaveBeenCalled();
});

it("counts what treg charged for an answer it cannot read", async () => {
  answerWith(mocks.fetch, {
    [PROFILE_URL]: () => tregResponse({ unexpected: true }, 840),
  });

  await expect(
    getInstagramProfileTool.handler(profileArgs, toolContext),
  ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  expect(mocks.adjustCalls).toHaveBeenCalledWith(
    expect.objectContaining({ delta: -9_160 }),
  );
});

it("attaches only the images Meta's CDN serves, and returns no expiring link", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  answerWith(mocks.fetch, {
    [POSTS_URL]: () =>
      tregResponse(
        {
          output: {
            posts: [
              {
                kind: "reel",
                likes: 100,
                taken_at: daysAgo(2),
                owner: "bandidos_restaurante",
                image: postImage("ok.jpg"),
                video_url: postImage("reel.mp4"),
              },
              // Another host: never fetched.
              {
                kind: "photo",
                likes: 20,
                taken_at: daysAgo(40),
                owner: "yoamopereira",
                image: "https://evil.example/photo.jpg",
              },
              { kind: "photo", likes: null, image: postImage("moved.jpg") },
              { kind: "photo", image: postImage("page.jpg") },
              { kind: "photo", image: postImage("huge.jpg") },
              { kind: "photo", image: "https://x.fbcdn.net/ok.png" },
            ],
          },
        },
        900,
      ),
    [postImage("ok.jpg")]: () =>
      new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } }),
    [postImage("moved.jpg")]: () =>
      new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/" },
      }),
    // The type comes from the bytes, never from the header: Meta's CDN has
    // labelled a PNG as a JPEG, and a page must never pass for an image.
    [postImage("page.jpg")]: () =>
      new Response("<html>", { headers: { "Content-Type": "image/jpeg" } }),
    [postImage("huge.jpg")]: () =>
      new Response(new Uint8Array(1_500_001), {
        headers: { "Content-Type": "image/jpeg" },
      }),
    "https://x.fbcdn.net/ok.png": () =>
      new Response(png, { headers: { "Content-Type": "image/jpeg" } }),
  });

  const result = await getInstagramPostsTool.handler(
    { ...profileArgs, images: 12 },
    toolContext,
  );

  expect(result.content.slice(1)).toEqual([
    { type: "image", data: "/9j/", mimeType: "image/jpeg" },
    { type: "image", data: "iVBORw==", mimeType: "image/png" },
  ]);
  const downloads = sentRequests(mocks.fetch).slice(1);
  expect(downloads.map((request) => request.url)).not.toContain(
    "https://evil.example/photo.jpg",
  );
  // A redirect is never followed: it could lead off Meta's CDN.
  expect(downloads.map((request) => request.redirect)).toEqual(
    downloads.map(() => "manual"),
  );
  const { posts, summary } = result.structuredContent;
  expect(posts.map((post) => post.image)).toEqual([
    1,
    null,
    null,
    null,
    null,
    2,
  ]);
  expect(posts[0]).toMatchObject({ hasVideo: true, isCollaboration: false });
  expect(posts[0]).not.toHaveProperty("imageUrl");
  expect(posts[0]).not.toHaveProperty("videoUrl");
  expect(JSON.stringify(result)).not.toContain("cdninstagram.com");
  // Averages skip a hidden like count; a collaboration belongs to its owner.
  expect(summary).toMatchObject({
    posts: 6,
    daysSinceNewest: 2,
    postsLast30Days: 1,
    averageLikes: 60,
    kinds: { reel: 1, photo: 5 },
    collaborations: 1,
  });
});

it("pays one provider only for an account search and drops rows without a handle", async () => {
  answerWith(mocks.fetch, {
    [SEARCH_URL]: () =>
      tregResponse(
        {
          output: {
            users: [
              {
                username: "bigburguer.co",
                full_name: "Big Burguer | Hamburguesas",
                follower_count: 16649,
              },
              { full_name: "No handle" },
            ],
          },
        },
        1880,
      ),
  });

  const result = await searchInstagramAccountsTool.handler(
    { projectId: "project_1", query: "Big Burguer Pereira" },
    toolContext,
  );

  expect(sentRequests(mocks.fetch)).toEqual([
    expect.objectContaining({
      url: SEARCH_URL,
      maxCost: "0.01",
      waterfall: "0",
      body: { q: "Big Burguer Pereira" },
    }),
  ]);
  expect(result.structuredContent.accounts).toEqual([
    expect.objectContaining({
      username: "bigburguer.co",
      url: "https://www.instagram.com/bigburguer.co/",
      followers: 16649,
    }),
  ]);
  // A pipe in a name must not read as a column break.
  expect(textContent(result)).toContain(
    "@bigburguer.co | Big Burguer ¦ Hamburguesas | 16649 |",
  );
});
