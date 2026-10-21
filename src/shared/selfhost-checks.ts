// Pure validators for self-host configuration values. Shared by the runtime
// (auth middleware, /api/health, telemetry) and the Docker preflight script,
// so every surface applies the exact same rules and wording.

export const MIN_BETTER_AUTH_SECRET_LENGTH = 32;

type TeamDomainResult =
  | { ok: true; origin: string }
  | { ok: false; message: string };

export function validateTeamDomain(value: string): TeamDomainResult {
  const normalized = value.trim().replace(/\/+$/, "");

  try {
    const parsed = new URL(normalized);

    if (parsed.protocol !== "https:") {
      throw new Error("TEAM_DOMAIN must use https");
    }

    return { ok: true, origin: parsed.origin };
  } catch {
    return {
      ok: false,
      message:
        "TEAM_DOMAIN must be a full https URL like https://your-team.cloudflareaccess.com" +
        (normalized && !normalized.includes("://")
          ? ` — add the https:// prefix to "${normalized}"`
          : ""),
    };
  }
}

// DATAFORSEO_API_KEY is NOT the key shown in the DataForSEO dashboard — it is
// base64("login:password"). Decoding it and finding a colon is a cheap sanity
// check that catches the most common paste mistake without a paid API call.
export function looksLikeDataForSeoKey(value: string): boolean {
  try {
    return atob(value.trim()).includes(":");
  } catch {
    return false;
  }
}

// DATAFORSEO_SCOPE=backlinks: each Backlinks API request takes one request of
// a monthly budget and may ask for at most 1,000 rows (DataForSEO's own
// maximum), so the budget bounds what a month can cost.
export const DEFAULT_BACKLINKS_MONTHLY_REQUESTS = 300;
export const BACKLINKS_MAX_ROWS_PER_REQUEST = 1000;

// DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS: the default when unset, null when it
// is not a whole number above 0.
export function parseBacklinksMonthlyRequests(
  value: string | undefined,
): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_BACKLINKS_MONTHLY_REQUESTS;
  return /^[1-9]\d{0,6}$/.test(trimmed) ? Number(trimmed) : null;
}

// OPENSEO_TELEMETRY_DISABLED / DO_NOT_TRACK semantics: any value except an
// explicit "off" string disables telemetry (fail toward privacy), but
// "0"/"false"/"no"/"off" mean what the operator wrote — telemetry stays on.
export function isTelemetryOptOutValue(
  value: string | undefined | null,
): boolean {
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
