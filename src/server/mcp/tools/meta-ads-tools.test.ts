import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getMetaAdLibraryAdsTool } from "./meta-ads-tools";
import { makeToolContext, textContent } from "./tool-test-support";
import {
  answerWith,
  sentRequests,
  setUpTregInstall,
  tregResponse,
} from "./treg-test-support";

// The Meta Ad Library tool on a self-hosted install with TREG_API_KEY. What
// every treg call shares (the cost ceiling, the monthly budget) is covered in
// instagram-tools.test.ts.

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
const ADS_URL = "https://treg.to/call/crawl4ai.meta-ads.library.advertiser";
const adImage = (name: string) => `https://scontent.xx.fbcdn.net/${name}`;
const AD_IMAGE_URL = adImage("ad.jpg");

/** A JPEG of `bytes` bytes, as Meta's CDN would serve it. */
function jpegOf(bytes: number) {
  const body = new Uint8Array(bytes);
  body.set([0xff, 0xd8, 0xff]);
  return new Response(body);
}

beforeEach(() => setUpTregInstall(mocks));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("reads a page's active ads in the project's country, names the page read and attaches the first image an ad has", async () => {
  answerWith(mocks.fetch, {
    [ADS_URL]: () =>
      tregResponse(
        {
          meta: {
            warnings: [
              "module: meta-ads-advertiser: 'RappiColombia' is the page RappiColombia (id 394048257466297)",
            ],
          },
          rows: [
            {
              ad_archive_id: 3035750866775197,
              page_id: "394048257466297",
              page_name: "Rappi",
              videos: ["https://video.xx.fbcdn.net/v.mp4"],
            },
            { ad_archive_id: "2", images: [AD_IMAGE_URL] },
          ],
        },
        1650,
      ),
    [AD_IMAGE_URL]: () => jpegOf(3),
  });

  const result = await getMetaAdLibraryAdsTool.handler(
    {
      projectId: "project_1",
      page: "https://www.facebook.com/RappiColombia",
      limit: 2,
      images: 1,
    },
    toolContext,
  );

  expect(sentRequests(mocks.fetch)[0]?.body).toEqual({
    page: "https://www.facebook.com/RappiColombia",
    country: "CO",
    active_status: "active",
    limit: 2,
  });
  expect(result.structuredContent).toMatchObject({
    country: "CO",
    pageUsed: { id: "394048257466297", name: "Rappi" },
    providerNotes: [
      "'RappiColombia' is the page RappiColombia (id 394048257466297)",
    ],
    adLibraryUrl:
      "https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=CO&view_all_page_id=394048257466297",
    // The one image wanted goes to the first ad that has one.
    ads: [
      { adArchiveId: "3035750866775197", videoCount: 1, image: null },
      { adArchiveId: "2", image: 1 },
    ],
    // As many ads as the limit came back, so the page may run more.
    limitReached: true,
    imagesAttached: 1,
    treg: { servedBy: "crawl4ai.meta-ads.library.advertiser" },
  });
  expect(textContent(result)).toContain(
    "2 active ads in CO from the Facebook page Rappi (page ID 394048257466297",
  );
});

it("says that finding no ads is not proof, and links the page the provider read", async () => {
  answerWith(mocks.fetch, {
    [ADS_URL]: () =>
      tregResponse(
        {
          meta: {
            warnings: [
              "module: meta-ads-advertiser: 'bandidosrestaurante' is the page bandidosrestaurante (id 1415949425334404)",
            ],
          },
          rows: [],
        },
        0,
      ),
  });

  const result = await getMetaAdLibraryAdsTool.handler(
    {
      projectId: "project_1",
      page: "https://www.facebook.com/bandidosrestaurante/",
      country: "co",
    },
    toolContext,
  );

  expect(result.structuredContent).toMatchObject({
    pageUsed: { id: "1415949425334404", name: null },
    ads: [],
    limitReached: false,
    treg: { chargedUsd: 0 },
  });
  expect(textContent(result)).toContain(
    "No ads found is not proof the page runs none",
  );
  expect(textContent(result)).toContain("view_all_page_id=1415949425334404");
});

it("leaves out an image that would take one answer past the size it may carry", async () => {
  answerWith(mocks.fetch, {
    [ADS_URL]: () =>
      tregResponse(
        {
          rows: ["a", "b", "c", "d"].map((name) => ({
            ad_archive_id: name,
            images: [adImage(name)],
          })),
        },
        1650,
      ),
    [adImage("a")]: () => jpegOf(1_400_000),
    [adImage("b")]: () => jpegOf(1_400_000),
    // The third would pass 3 MB: it is left out, and the small one after it
    // still fits.
    [adImage("c")]: () => jpegOf(1_400_000),
    [adImage("d")]: () => jpegOf(100_000),
  });

  const result = await getMetaAdLibraryAdsTool.handler(
    { projectId: "project_1", page: "394048257466297" },
    toolContext,
  );

  expect(result.structuredContent.ads.map((ad) => ad.image)).toEqual([
    1,
    2,
    null,
    3,
  ]);
  expect(result.content.slice(1)).toHaveLength(3);
});
