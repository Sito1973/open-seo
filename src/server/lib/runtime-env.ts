import { isHostedAuthMode } from "@/lib/auth-mode";

let workersEnvPromise: Promise<Record<string, unknown> | null> | null = null;

export async function getOptionalEnvValue(
  name: string,
): Promise<string | undefined> {
  return getEnvValueSync((await getWorkersEnv()) ?? {}, name);
}

/**
 * Sync variant for callers that already hold an env record (e.g. a Durable
 * Object's `this.env`, needed because Think's `getModel()` hook is sync).
 * Same policy as the async form: process.env first (where local `.env.local`
 * secrets land in dev), skipping empty strings, then the given env.
 */
export function getEnvValueSync(
  // `object` so interface-typed envs (e.g. Cloudflare.Env) are accepted
  // without a cast.
  env: object,
  name: string,
): string | undefined {
  const processValue =
    typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (processValue) {
    return processValue;
  }
  const value: unknown = Reflect.get(env, name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function getRequiredEnvValue(name: string): Promise<string> {
  const value = await getOptionalEnvValue(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function isHostedServerAuthMode(): Promise<boolean> {
  return isHostedAuthMode(await getOptionalEnvValue("AUTH_MODE"));
}

/**
 * DATAFORSEO_SCOPE=backlinks keeps DataForSEO to its Backlinks API on a
 * self-hosted install, under a monthly request budget (see
 * meterBacklinks in dataforseo/client.ts). Hosted ignores it and always uses
 * DataForSEO for everything. Any other value counts as backlinks too, so a
 * typo can never widen spending; the startup preflight rejects it.
 */
export async function isDataforseoBacklinksOnly(): Promise<boolean> {
  const scope = await getOptionalEnvValue("DATAFORSEO_SCOPE");
  if (!scope?.trim()) return false;
  return !(await isHostedServerAuthMode());
}

/**
 * DATAFORSEO_API_KEY for requests to the Backlinks API or to any other
 * DataForSEO API, or null when this server does not use DataForSEO for them:
 * the key is unset, or DATAFORSEO_SCOPE=backlinks keeps the other APIs off
 * DataForSEO. A feature without a key behaves as on an install without
 * DataForSEO, so its stand-in provider applies.
 */
export async function getDataforseoKey(
  api: "backlinks" | "other",
): Promise<string | null> {
  if (api === "other" && (await isDataforseoBacklinksOnly())) return null;
  return (await getOptionalEnvValue("DATAFORSEO_API_KEY")) ?? null;
}

/**
 * Whether stand-ins for DataForSEO apply: a self-hosted install that does not
 * use DataForSEO for features other than backlinks (no key, or a key kept to
 * backlinks by DATAFORSEO_SCOPE). Hosted billing and every install that uses
 * DataForSEO for them keep their exact behavior.
 */
export async function usesGoogleFallbacks(): Promise<boolean> {
  if (await getDataforseoKey("other")) return false;
  return !(await isHostedServerAuthMode());
}

/**
 * A key for a provider of Google data that stands in for DataForSEO: a free
 * Google API, the Google Ads Keyword Planner, Bright Data's live Google SERP,
 * or SerpApi's Google AI Mode. Null unless usesGoogleFallbacks().
 */
export async function getGoogleFallbackKey(
  name:
    | "GOOGLE_PAGESPEED_API_KEY"
    | "GOOGLE_PLACES_API_KEY"
    | "GOOGLE_ADS_CUSTOMER_ID"
    | "BRIGHTDATA_API_KEY"
    | "SERPAPI_API_KEY",
): Promise<string | null> {
  if (!(await usesGoogleFallbacks())) return null;
  return (await getOptionalEnvValue(name)) ?? null;
}

async function getWorkersEnv(): Promise<Record<string, unknown> | null> {
  if (!workersEnvPromise) {
    workersEnvPromise = loadWorkersEnv();
  }
  return workersEnvPromise;
}

async function loadWorkersEnv(): Promise<Record<string, unknown> | null> {
  try {
    const workersModule = await import("cloudflare:workers");
    return isRecord(workersModule.env) ? workersModule.env : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
