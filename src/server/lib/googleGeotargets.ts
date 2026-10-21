import Papa from "papaparse";
import { z } from "zod";
import { AppError } from "@/server/lib/errors";

// Google Ads' geo targets file, the location registry of a self-hosted install
// without DataForSEO. Its criteria IDs are DataForSEO's location codes and its
// canonical names DataForSEO's location names, so trackers and saved
// locations read the same either way. Google posts a new dated file every few
// months at https://developers.google.com/google-ads/api/data/geotargets; this
// is pinned to one so a page redesign cannot break it. Bump the date to pick up
// new locations.
const GEOTARGETS_URL =
  "https://developers.google.com/static/google-ads/api/data/geo/geotargets-2026-10-06.csv.zip";
const REQUEST_TIMEOUT_MS = 60_000;

// The zip holds one CSV, deflated, with its size in the local file header.
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_LOCAL_HEADER_LENGTH = 30;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_FLAG_DATA_DESCRIPTOR = 0x8;

const geotargetRowSchema = z.object({
  "Criteria ID": z.coerce.number().int().positive(),
  "Canonical Name": z.string().min(1),
  "Country Code": z.string(),
  "Target Type": z.string(),
  Status: z.string(),
});

/**
 * The active geo targets of one country (ISO 3166-1 alpha-2), every type
 * included. The file is ~23 MB unzipped, so it is read as a stream and only
 * the country's lines are parsed.
 */
export async function fetchGoogleGeotargets(
  countryCode: string,
): Promise<
  { locationCode: number; locationName: string; locationType: string }[]
> {
  const country = countryCode.toUpperCase();
  const zip = await downloadZip();
  let csv: string;
  try {
    csv = await readCountryLines(zip, `,"${country}",`);
  } catch (error) {
    console.warn("[geotargets] unreadable file:", error);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Google's location list could not be read.",
    );
  }

  const rows = Papa.parse<unknown>(csv, { header: true, skipEmptyLines: true });
  return rows.data.flatMap((row) => {
    const parsed = geotargetRowSchema.safeParse(row);
    if (
      !parsed.success ||
      parsed.data["Country Code"] !== country ||
      parsed.data.Status !== "Active"
    ) {
      return [];
    }
    return [
      {
        locationCode: parsed.data["Criteria ID"],
        locationName: parsed.data["Canonical Name"],
        locationType: parsed.data["Target Type"],
      },
    ];
  });
}

async function downloadZip(): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(GEOTARGETS_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("[geotargets] request failed:", error);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Google's location list could not be downloaded.",
    );
  }
  if (!response.ok) {
    console.warn(`[geotargets] HTTP ${response.status}`);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      `Google's location list answered HTTP ${response.status}.`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** The CSV's header line and every line that contains `needle`. */
async function readCountryLines(
  zip: Uint8Array,
  needle: string,
): Promise<string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (
    zip.byteLength < ZIP_LOCAL_HEADER_LENGTH ||
    view.getUint32(0, true) !== ZIP_LOCAL_HEADER_SIGNATURE ||
    view.getUint16(8, true) !== ZIP_METHOD_DEFLATE ||
    (view.getUint16(6, true) & ZIP_FLAG_DATA_DESCRIPTOR) !== 0
  ) {
    throw new Error("not a single deflated file with its size in the header");
  }
  const start =
    ZIP_LOCAL_HEADER_LENGTH +
    view.getUint16(26, true) +
    view.getUint16(28, true);
  const deflated = zip.slice(start, start + view.getUint32(18, true));
  const reader = new Blob([deflated])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .pipeThrough(new TextDecoderStream())
    .getReader();

  const kept: string[] = [];
  let partial = "";
  for (;;) {
    const { done, value } = await reader.read();
    const lines = (partial + (value ?? "")).split(/\r?\n/);
    partial = done ? "" : (lines.pop() ?? "");
    // The first line is the header.
    for (const line of lines) {
      if (kept.length === 0 || line.includes(needle)) kept.push(line);
    }
    if (done) return kept.join("\n");
  }
}
