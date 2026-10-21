import { timingSafeEqual } from "node:crypto";
import type { Plugin } from "vite";
import {
  SCHEDULER_TOKEN_ENV,
  SCHEDULER_TOKEN_HEADER,
} from "./scripts/selfhost-scheduler.mjs";

const SCHEDULED_PATH = "/cdn-cgi/handler/scheduled";

/**
 * `vite preview` (the Docker runtime) hands every request to Miniflare, which
 * answers /cdn-cgi/* itself (scheduled-handler triggers, public R2 reads)
 * before the worker runs, so SELFHOST_ACCESS_KEY never sees them. Only the
 * self-host scheduler needs one of those routes; it proves itself with the
 * per-boot token it hands this process.
 */
export function previewCdnCgiGuard(): Plugin {
  return {
    name: "openseo:preview-cdn-cgi-guard",
    // Registered before the Cloudflare plugin's catch-all middleware.
    enforce: "pre",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        // Same parse as the Cloudflare plugin, so absolute-form and `//host`
        // request targets resolve to the path Miniflare will route on.
        const { pathname } = new URL(
          req.originalUrl ?? req.url ?? "/",
          "http://localhost",
        );
        if (!pathname.startsWith("/cdn-cgi/")) return next();
        const token = process.env[SCHEDULER_TOKEN_ENV];
        const presented = req.headers[SCHEDULER_TOKEN_HEADER];
        if (
          pathname === SCHEDULED_PATH &&
          token &&
          typeof presented === "string" &&
          presented.length === token.length &&
          timingSafeEqual(Buffer.from(presented), Buffer.from(token))
        ) {
          return next();
        }
        res.statusCode = 404;
        res.end();
      });
    },
  };
}
