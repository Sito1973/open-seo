// Instagram and Facebook media links expire within hours or days, so a tool
// that shows a post or an ad downloads its image while the link still works.
// The links come from provider data, not from this server, so only Meta's own
// CDN hosts are fetched, over https and without following redirects: a link
// to any other host, or one that redirects, is skipped.
const ALLOWED_HOST_SUFFIXES = [".cdninstagram.com", ".fbcdn.net"];
const DOWNLOAD_TIMEOUT_MS = 15_000;
/** A post image is 30-70 KB, an ad image up to about 1.3 MB. */
const MAX_IMAGE_BYTES = 1_500_000;

type DownloadedImage = { body: Uint8Array; mimeType: string };

function isMetaCdnUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    ALLOWED_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))
  );
}

/** The body, or null once it passes MAX_IMAGE_BYTES (a CDN can omit the length). */
async function readBounded(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * The image type the first bytes give, of the types MCP clients and vision
 * models accept, or null for anything else. The Content-Type header is not
 * trusted: Meta's CDN has served a PNG labelled image/jpeg, and a model's API
 * rejects an image whose declared type does not match its bytes.
 */
function imageType(body: Uint8Array): string | null {
  const startsWith = (signature: number[], offset = 0) =>
    signature.every((byte, index) => body[offset + index] === byte);
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // "RIFF", four bytes of length, then "WEBP".
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    startsWith([0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * One image from Meta's CDN, or null when it cannot be had: another host, an
 * expired or redirected link, a body that is not an image, or too large. A
 * missing image never fails the call that asked for it.
 */
export async function downloadMetaCdnImage(
  url: string,
): Promise<DownloadedImage | null> {
  if (!isMetaCdnUrl(url)) return null;
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status !== 200) return null;
    const body = await readBounded(response);
    const mimeType = body && imageType(body);
    return body && mimeType ? { body, mimeType } : null;
  } catch {
    return null;
  }
}
