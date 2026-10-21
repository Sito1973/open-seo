import { MCP_ROUTE } from "@/server/mcp/context";
import { timingSafeEqual } from "@/server/lib/timing-safe-equal";

/**
 * Optional access key for Docker self-hosting (AUTH_MODE=local_noauth).
 * Returns null to let a request through (always when no key is set), else a
 * 401: a Bearer challenge on /mcp, a browser Basic login (any username, the
 * key as password) everywhere else.
 *
 * Open paths: /api/health (Docker healthcheck, uptime monitors), MCP CORS
 * preflights (never carry credentials), and /.well-known/* (only public files
 * live there; kept open so an MCP client that probes OAuth metadata before its
 * first request gets a 404, not a Basic challenge).
 */
export function checkSelfHostAccess(
  request: Request,
  pathname: string,
  key: string | undefined,
): Response | null {
  if (!key) return null;
  const mcp = pathname === MCP_ROUTE;
  if (
    pathname === "/api/health" ||
    pathname === "/api/health/" ||
    pathname.startsWith("/.well-known/") ||
    (mcp && request.method === "OPTIONS")
  ) {
    return null;
  }

  const presented = [presentedKey(request.headers.get("Authorization"))];
  // Claude.ai custom connectors take only a URL, so /mcp also accepts ?key=.
  if (mcp) presented.push(new URL(request.url).searchParams.get("key"));
  if (presented.some((value) => value !== null && timingSafeEqual(value, key)))
    return null;

  if (mcp) {
    return Response.json(
      {
        error:
          "Add ?key=<SELFHOST_ACCESS_KEY> to the MCP URL or send Authorization: Bearer <SELFHOST_ACCESS_KEY>.",
      },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer realm="OpenSEO"',
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "WWW-Authenticate",
        },
      },
    );
  }
  return new Response(
    "Sign in with any username and your OpenSEO access key.",
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="OpenSEO"' },
    },
  );
}

/** The key from `Bearer <key>` or `Basic base64(<any user>:<key>)`. */
function presentedKey(header: string | null): string | null {
  const [scheme = "", value = ""] = header?.split(" ") ?? [];
  if (scheme.toLowerCase() === "bearer") return value || null;
  if (scheme.toLowerCase() !== "basic") return null;
  try {
    const decoded = atob(value);
    const colon = decoded.indexOf(":");
    return colon === -1 ? null : decoded.slice(colon + 1);
  } catch {
    return null;
  }
}
