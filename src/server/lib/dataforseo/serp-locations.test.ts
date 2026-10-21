import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertSerpLocationNameAccepted } from "./serp-location-validate";
import { fetchSerpLocationsForCountry } from "./serp-locations";

// The location registry behind the city picker, search_serp_locations and
// location checks: DataForSEO's list, or on a self-hosted install without
// DataForSEO, Google Ads' geo targets file.

const mocks = vi.hoisted(() => ({
  kvGet: vi.fn(),
  kvPut: vi.fn(),
  dataforseoGet: vi.fn(),
  dataforseoPost: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { KV: { get: mocks.kvGet, put: mocks.kvPut } },
}));
vi.mock("@/server/lib/dataforseo/core", () => ({
  dataforseoGet: mocks.dataforseoGet,
  dataforseoPost: mocks.dataforseoPost,
}));

const PEREIRA = {
  locationCode: 1003665,
  locationName: "Pereira,Risaralda,Colombia",
  locationType: "City",
  displayLabel: "Pereira, Risaralda, Colombia",
};

const GEOTARGETS_CSV = [
  "Criteria ID,Name,Canonical Name,Parent ID,Country Code,Target Type,Status",
  // Enough rows of another country that the file streams in several chunks.
  ...Array.from(
    { length: 4000 },
    (_, index) =>
      `"${2000000 + index}","Town","Town,State of Sao Paulo,Brazil","20106","BR","City",Active`,
  ),
  '"1003665","Pereira","Pereira,Risaralda,Colombia","20208","CO","City",Active',
  '"9198430","Pereira","Pereira,Pereira,Risaralda,Colombia","20208","CO","City",Active',
  '"9000001","660001","660001,Risaralda,Colombia","20208","CO","Postal Code",Active',
  '"9000002","Cartago","Cartago,Valle del Cauca,Colombia","20212","CO","City",Removal Planned',
].join("\n");

/** A zip of one deflated file, laid out like Google's. */
async function zipOf(text: string): Promise<Blob> {
  const deflated = await new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw")),
  ).arrayBuffer();
  const name = new TextEncoder().encode("geotargets.csv");
  const header = new Uint8Array(30 + name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(8, 8, true);
  view.setUint32(18, deflated.byteLength, true);
  view.setUint16(26, name.length, true);
  header.set(name, 30);
  // Bytes after the file stand in for the zip's central directory.
  return new Blob([header, deflated, new Uint8Array([0x50, 0x4b, 0x01, 0x02])]);
}

beforeEach(async () => {
  vi.stubEnv("DATAFORSEO_API_KEY", "");
  vi.stubEnv("AUTH_MODE", "");
  vi.stubGlobal("fetch", mocks.fetch);
  const zip = await zipOf(GEOTARGETS_CSV);
  mocks.fetch.mockImplementation(async () => new Response(zip));
  mocks.kvGet.mockResolvedValue(null);
  mocks.kvPut.mockResolvedValue(undefined);
  mocks.dataforseoGet.mockResolvedValue({
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        result: [
          {
            location_code: 1003665,
            location_name: "Pereira,Risaralda,Colombia",
            location_type: "City",
          },
        ],
      },
    ],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("builds a country's list from Google's geo targets file without DataForSEO", async () => {
  const locations = await fetchSerpLocationsForCountry("co");

  // Active cities, counties and regions only, each under its full name.
  expect(locations).toEqual([
    PEREIRA,
    {
      locationCode: 9198430,
      locationName: "Pereira,Pereira,Risaralda,Colombia",
      locationType: "City",
      displayLabel: "Pereira, Pereira, Risaralda, Colombia",
    },
  ]);
  expect(mocks.fetch).toHaveBeenCalledWith(
    expect.stringMatching(/\/geotargets-\d{4}-\d{2}-\d{2}\.csv\.zip$/),
    expect.anything(),
  );
  expect(mocks.dataforseoGet).not.toHaveBeenCalled();
  expect(mocks.kvPut).toHaveBeenCalledWith(
    "serp-locations:co",
    JSON.stringify(locations),
    { expirationTtl: 30 * 24 * 60 * 60 },
  );
});

it.each([
  ["DataForSEO serves every feature", "DATAFORSEO_API_KEY", "dataforseo-key"],
  ["the server is hosted", "AUTH_MODE", "hosted"],
])("keeps DataForSEO's list when %s", async (_case, name, value) => {
  vi.stubEnv(name, value);

  const locations = await fetchSerpLocationsForCountry("co");

  expect(locations).toEqual([PEREIRA]);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("rejects a tracker city missing from Google's list without DataForSEO", async () => {
  mocks.kvGet.mockResolvedValue([PEREIRA]);
  const tracker = { languageCode: "es", countryCode: "co" };

  await expect(
    assertSerpLocationNameAccepted({
      ...tracker,
      locationName: "Pereira,Risaralda,Colombia",
    }),
  ).resolves.toBeUndefined();
  const unknown = assertSerpLocationNameAccepted({
    ...tracker,
    locationName: "Pereira, Colombia",
  });
  await expect(unknown).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(unknown).rejects.toThrow("search_serp_locations");
  expect(mocks.dataforseoPost).not.toHaveBeenCalled();
});

it("saves a tracker city unchecked when Google's list cannot load", async () => {
  mocks.fetch.mockRejectedValue(new TypeError("fetch failed"));

  await expect(
    assertSerpLocationNameAccepted({
      locationName: "Pereira,Risaralda,Colombia",
      languageCode: "es",
      countryCode: "co",
    }),
  ).resolves.toBeUndefined();
});
