import { AUTH_MODES } from "@/lib/auth-mode";
import {
  BACKLINKS_MAX_ROWS_PER_REQUEST,
  DEFAULT_BACKLINKS_MONTHLY_REQUESTS,
  looksLikeDataForSeoKey,
  MIN_BETTER_AUTH_SECRET_LENGTH,
  parseBacklinksMonthlyRequests,
  validateTeamDomain,
} from "@/shared/selfhost-checks";

// Startup preflight for self-host containers: validate the environment BEFORE
// the multi-minute build/boot so misconfiguration fails in seconds with the
// exact fix, instead of surfacing minutes later as a generic in-app error.
// "fail" aborts startup; "warn" degrades a feature; "info" is orientation.

type PreflightLevel = "ok" | "info" | "warn" | "fail";

type PreflightItem = {
  // Stable identifier shared with /api/health's check map.
  key:
    | "auth"
    | "dataforseo"
    | "gsc"
    | "ai"
    | "rendering"
    | "ahrefs"
    | "runtime";
  name: string;
  level: PreflightLevel;
  message: string;
};

type PreflightResult = {
  items: PreflightItem[];
  failed: boolean;
};

type EnvRecord = Record<string, string | undefined>;

const MIN_SELFHOST_ACCESS_KEY_LENGTH = 32;

function get(env: EnvRecord, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function checkAuthMode(env: EnvRecord, items: PreflightItem[]): void {
  const rawMode = get(env, "AUTH_MODE");

  if (rawMode && !(AUTH_MODES as readonly string[]).includes(rawMode)) {
    items.push({
      key: "auth",
      name: "AUTH_MODE",
      level: "fail",
      message: `"${rawMode}" is not a valid AUTH_MODE. Valid values: ${AUTH_MODES.join(", ")}.`,
    });
    return;
  }

  const mode = rawMode ?? "cloudflare_access";

  if (mode === "local_noauth") {
    const accessKey = get(env, "SELFHOST_ACCESS_KEY");
    if (!accessKey) {
      items.push({
        key: "auth",
        name: "AUTH_MODE",
        level: "ok",
        message:
          "local_noauth — no auth, single admin user. Do not expose publicly without SELFHOST_ACCESS_KEY or your own auth in front.",
      });
    } else if (
      accessKey.length < MIN_SELFHOST_ACCESS_KEY_LENGTH ||
      // The key travels in a URL query, a Bearer header and a Basic login.
      !/^[A-Za-z0-9._~-]+$/.test(accessKey)
    ) {
      items.push({
        key: "auth",
        name: "AUTH_MODE",
        level: "fail",
        message: `SELFHOST_ACCESS_KEY must be at least ${MIN_SELFHOST_ACCESS_KEY_LENGTH} characters of letters, digits, '.', '_', '~' or '-'. Generate one with: openssl rand -hex 32`,
      });
    } else {
      items.push({
        key: "auth",
        name: "AUTH_MODE",
        level: "ok",
        message: "local_noauth — the app and MCP require SELFHOST_ACCESS_KEY.",
      });
    }
    return;
  }

  if (mode === "hosted") {
    const missing = [
      "BETTER_AUTH_URL",
      "BETTER_AUTH_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ].filter((name) => !get(env, name));
    items.push(
      missing.length
        ? {
            key: "auth",
            name: "AUTH_MODE",
            level: "fail",
            message: `hosted mode requires ${missing.join(", ")}.`,
          }
        : { key: "auth", name: "AUTH_MODE", level: "ok", message: "hosted" },
    );
    return;
  }

  // cloudflare_access (explicit or defaulted)
  const teamDomain = get(env, "TEAM_DOMAIN");
  const policyAud = get(env, "POLICY_AUD");
  const modeLabel = rawMode
    ? "cloudflare_access"
    : "cloudflare_access (default — AUTH_MODE is unset)";

  if (!teamDomain || !policyAud) {
    const missing = [
      teamDomain ? null : "TEAM_DOMAIN",
      policyAud ? null : "POLICY_AUD",
    ]
      .filter(Boolean)
      .join(" and ");
    items.push({
      key: "auth",
      name: "AUTH_MODE",
      level: "fail",
      message: `${modeLabel} requires ${missing}. See docs/SELF_HOSTING_CLOUDFLARE.md — or set AUTH_MODE=local_noauth for a private, no-auth deployment.`,
    });
    return;
  }

  const teamDomainResult = validateTeamDomain(teamDomain);
  if (!teamDomainResult.ok) {
    items.push({
      key: "auth",
      name: "TEAM_DOMAIN",
      level: "fail",
      message: teamDomainResult.message,
    });
    return;
  }

  items.push({
    key: "auth",
    name: "AUTH_MODE",
    level: "ok",
    message: modeLabel,
  });
}

// Providers that stand in for DataForSEO while it is unset or kept to
// backlinks.
function standInProviders(env: EnvRecord): string[] {
  const replacements: string[] = [];
  if (get(env, "GOOGLE_PAGESPEED_API_KEY")) {
    replacements.push("site audit Lighthouse checks (PageSpeed Insights)");
  }
  if (get(env, "GOOGLE_PLACES_API_KEY")) {
    replacements.push(
      "the Maps rank grid, local SERP, local business search and place details (Google Places)",
    );
  }
  if (get(env, "BRIGHTDATA_API_KEY") && get(env, "BRIGHTDATA_SERP_ZONE")) {
    replacements.push(
      "rank tracking, get_serp_results and find_serp_competitors (Bright Data live Google SERP)",
    );
  }
  if (
    get(env, "GOOGLE_ADS_CLIENT_ID") &&
    get(env, "GOOGLE_ADS_CLIENT_SECRET") &&
    get(env, "GOOGLE_ADS_CUSTOMER_ID")
  ) {
    replacements.push(
      "keyword volumes and ideas once Google Ads is connected in Settings → Integrations (Google Ads Keyword Planner)",
    );
  }
  if (get(env, "SERPAPI_API_KEY")) {
    replacements.push("Google AI Mode answers in AI visibility (SerpApi)");
  }
  if (get(env, "BRIGHTDATA_API_KEY") && get(env, "BRIGHTDATA_SERP_ZONE")) {
    replacements.push(
      "Google AI Overviews answers in AI visibility (Bright Data)",
    );
    replacements.push(
      get(env, "OPENPAGERANK_API_KEY")
        ? "keyword difficulty estimates from the local pack and Open PageRank"
        : "keyword difficulty estimates from the local pack (set OPENPAGERANK_API_KEY to add the top 10's authority)",
    );
  }
  return replacements;
}

/**
 * What serves SEO data on this install, shared by the startup preflight,
 * /api/health and the app shell's setup prompt: DataForSEO for every feature,
 * DataForSEO for backlinks only (DATAFORSEO_SCOPE), or no DataForSEO, plus the
 * stand-ins that apply whenever DataForSEO does not serve the other features.
 * Hosted always uses DataForSEO for everything and never runs stand-ins.
 */
export function seoDataProviders(env: EnvRecord): {
  dataforseo: "all" | "backlinks" | null;
  standIns: string[];
} {
  const hosted = get(env, "AUTH_MODE") === "hosted";
  const key = get(env, "DATAFORSEO_API_KEY");
  if (key && (hosted || !get(env, "DATAFORSEO_SCOPE"))) {
    return { dataforseo: "all", standIns: [] };
  }
  return {
    dataforseo: key ? "backlinks" : null,
    standIns: hosted ? [] : standInProviders(env),
  };
}

function checkDataForSeo(env: EnvRecord, items: PreflightItem[]): void {
  const key = get(env, "DATAFORSEO_API_KEY");
  // Hosted always uses DataForSEO for everything and ignores the scope.
  const scope =
    get(env, "AUTH_MODE") === "hosted"
      ? undefined
      : get(env, "DATAFORSEO_SCOPE");
  const monthlyRequests = parseBacklinksMonthlyRequests(
    get(env, "DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS"),
  );

  if (scope && scope !== "backlinks") {
    items.push({
      key: "dataforseo",
      name: "DATAFORSEO_SCOPE",
      level: "fail",
      message: `"${scope}" is not a valid DATAFORSEO_SCOPE. Set it to backlinks to use DataForSEO for backlinks only, or leave it unset to use DataForSEO for every feature.`,
    });
    return;
  }

  if (scope && monthlyRequests === null) {
    items.push({
      key: "dataforseo",
      name: "DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS",
      level: "fail",
      message: `Must be a whole number of requests above 0, or unset for the default of ${DEFAULT_BACKLINKS_MONTHLY_REQUESTS}.`,
    });
    return;
  }

  const replacements = seoDataProviders(env).standIns;

  if (!key) {
    const impact = replacements.length
      ? `stand-in providers cover ${replacements.join(", ")}; every other SEO data feature stays unavailable until it is set.`
      : "all SEO data features will be unavailable until it is.";
    items.push({
      key: "dataforseo",
      name: "DATAFORSEO_API_KEY",
      level: "warn",
      message: `Not set — ${impact} It is the base64 of your DataForSEO login:password (NOT the dashboard API key). See docs/DATAFORSEO_API_KEY.md.`,
    });
    return;
  }

  if (!looksLikeDataForSeoKey(key)) {
    items.push({
      key: "dataforseo",
      name: "DATAFORSEO_API_KEY",
      level: "warn",
      message:
        "Set, but does not decode as base64 of login:password. If DataForSEO rejects it, encode your account email and API password: printf 'email:password' | base64.",
    });
    return;
  }

  if (scope) {
    const others = replacements.length
      ? `Stand-in providers cover ${replacements.join(", ")}; every other SEO data feature stays unavailable.`
      : "Every other SEO data feature stays unavailable.";
    items.push({
      key: "dataforseo",
      name: "DATAFORSEO_API_KEY",
      level: "ok",
      message: `Set, for backlinks only (DATAFORSEO_SCOPE=backlinks): at most ${monthlyRequests} requests a month (UTC), up to ${BACKLINKS_MAX_ROWS_PER_REQUEST.toLocaleString("en-US")} rows each. ${others}`,
    });
    return;
  }

  items.push({
    key: "dataforseo",
    name: "DATAFORSEO_API_KEY",
    level: "ok",
    message: "Set",
  });
}

function checkOptionalFeatures(env: EnvRecord, items: PreflightItem[]): void {
  const clientId = get(env, "GOOGLE_CLIENT_ID");
  const clientSecret = get(env, "GOOGLE_CLIENT_SECRET");
  const betterAuthSecret = get(env, "BETTER_AUTH_SECRET");

  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) {
      items.push({
        key: "gsc",
        name: "Search Console",
        level: "warn",
        message:
          "Only one of GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET is set — both are required.",
      });
    } else if (
      !betterAuthSecret ||
      betterAuthSecret.length < MIN_BETTER_AUTH_SECRET_LENGTH
    ) {
      items.push({
        key: "gsc",
        name: "Search Console",
        level: "warn",
        message: `Google credentials are set, but Search Console stays DISABLED until BETTER_AUTH_SECRET is at least ${MIN_BETTER_AUTH_SECRET_LENGTH} characters (it encrypts stored OAuth tokens).`,
      });
    } else {
      items.push({
        key: "gsc",
        name: "Search Console",
        level: "ok",
        message: "Configured",
      });
    }
  } else {
    items.push({
      key: "gsc",
      name: "Search Console",
      level: "info",
      message:
        "Not configured (optional). See docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md.",
    });
  }

  items.push(
    get(env, "OPENROUTER_API_KEY")
      ? {
          key: "ai",
          name: "AI features",
          level: "ok",
          message: "OPENROUTER_API_KEY set",
        }
      : {
          key: "ai",
          name: "AI features",
          level: "info",
          message:
            "OPENROUTER_API_KEY not set (optional) — SAM, the in-app SEO agent, is disabled.",
        },
  );

  items.push(
    get(env, "AHREFS_API_KEY")
      ? {
          key: "ahrefs",
          name: "Ahrefs Domain Rating",
          level: "ok",
          message: "AHREFS_API_KEY set",
        }
      : {
          key: "ahrefs",
          name: "Ahrefs Domain Rating",
          level: "info",
          message:
            "AHREFS_API_KEY not set (optional) — the Backlinks tables' Ahrefs DR column stays empty. A free Ahrefs account's APIv3 key enables it. See docs/SELF_HOSTING_GOOGLE_APIS.md.",
        },
  );

  items.push(
    get(env, "CONTEXT_API_KEY")
      ? {
          key: "rendering",
          name: "JavaScript rendering",
          level: "ok",
          message: "CONTEXT_API_KEY set",
        }
      : {
          key: "rendering",
          name: "JavaScript rendering",
          level: "info",
          message:
            'CONTEXT_API_KEY not set (optional) — on Docker the site audit "Render JavaScript" option is disabled; on Cloudflare, Browser Run renders without a fallback.',
        },
  );
}

// Shared per-feature checks: the Docker preflight prints these at boot and
// /api/health (setup-status.ts) serves the same results at runtime, so the
// two can never drift.
export function runSelfhostChecks(env: EnvRecord): PreflightItem[] {
  const items: PreflightItem[] = [];
  checkAuthMode(env, items);
  checkDataForSeo(env, items);
  checkOptionalFeatures(env, items);
  return items;
}

export function runSelfhostPreflight(env: EnvRecord): PreflightResult {
  const items = runSelfhostChecks(env);

  items.push(
    get(env, "ALLOWED_HOST")
      ? {
          key: "runtime",
          name: "ALLOWED_HOST",
          level: "ok",
          message: `Requests allowed for host ${get(env, "ALLOWED_HOST")}`,
        }
      : {
          key: "runtime",
          name: "ALLOWED_HOST",
          level: "info",
          message:
            'Not set — only localhost access will work. Behind a reverse proxy or tunnel, set ALLOWED_HOST=yourdomain.com or requests are blocked with Vite\'s "Blocked request" page.',
        },
  );

  items.push({
    key: "runtime",
    name: "Scheduled checks",
    level: "info",
    message:
      "The container's built-in scheduler runs scheduled rank checks, AI visibility checks and other due work every five minutes while it runs. Failures appear as [scheduler] lines in the logs.",
  });

  return { items, failed: items.some((item) => item.level === "fail") };
}

const LEVEL_BADGES: Record<PreflightLevel, string> = {
  ok: "[ ok ]",
  info: "[info]",
  warn: "[warn]",
  fail: "[FAIL]",
};

export function formatPreflightReport(result: PreflightResult): string {
  const lines = result.items.map(
    (item) => `${LEVEL_BADGES[item.level]} ${item.name}: ${item.message}`,
  );

  lines.push(
    result.failed
      ? "\nPreflight failed — fix the [FAIL] items above and restart. Nothing was started."
      : "\nPreflight passed. The app now builds inside the container (~1-2 minutes on first start before it serves).",
  );

  return lines.join("\n");
}
