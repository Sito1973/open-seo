import { z } from "zod";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";

// Colombia's official peso-dollar rate (TRM, Tasa Representativa del Mercado),
// from the Superintendencia Financiera's open dataset on datos.gov.co. Free and
// keyless. The host is fixed, so no SSRF screening applies.
const TRM_URL = `https://www.datos.gov.co/resource/32sa-8pi3.json?${new URLSearchParams(
  { $select: "valor", $order: "vigenciadesde DESC", $limit: "1" },
)}`;
const REQUEST_TIMEOUT_MS = 10_000;
// The rate changes once a day.
const CACHE_TTL_SECONDS = 24 * 60 * 60;

// Socrata returns numbers as strings.
const trmSchema = z
  .array(z.object({ valor: z.coerce.number().positive() }))
  .min(1);

/**
 * Colombian pesos per US dollar on the latest day the dataset lists, or null
 * when datos.gov.co cannot be read. Cached for the day.
 */
export async function getCopPerUsd(): Promise<number | null> {
  const key = await buildCacheKey("trm:cop-per-usd", {
    day: new Date().toISOString().slice(0, 10),
  });
  const cached = z
    .number()
    .positive()
    .safeParse(await getCached(key));
  if (cached.success) return cached.data;
  try {
    const response = await fetch(TRM_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const [latest] = trmSchema.parse(await response.json());
    await setCached(key, latest.valor, CACHE_TTL_SECONDS);
    return latest.valor;
  } catch (error) {
    console.warn("trm.fetch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
