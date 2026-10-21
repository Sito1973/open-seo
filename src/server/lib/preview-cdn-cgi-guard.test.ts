import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connect, PreviewServer } from "vite";
import { previewCdnCgiGuard } from "../../../vite-plugin-preview-cdn-cgi-guard";

const TOKEN = "t".repeat(64);

function guard() {
  let middleware: Connect.NextHandleFunction | undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the guard only calls middlewares.use
  const server = {
    middlewares: {
      use: (fn: Connect.NextHandleFunction) => (middleware = fn),
    },
  } as unknown as PreviewServer;
  const hook = previewCdnCgiGuard().configurePreviewServer;
  if (typeof hook !== "function") throw new Error("expected a hook function");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook never reads its plugin context
  void hook.call({} as never, server);
  return (url: string, headers: Record<string, string> = {}) => {
    const req = new IncomingMessage(new Socket());
    req.url = url;
    req.headers = headers;
    const res = new ServerResponse(req);
    const next = vi.fn();
    middleware?.(req, res, next);
    return next.mock.calls.length ? "passed" : res.statusCode;
  };
}

beforeEach(() => {
  vi.stubEnv("OPENSEO_SCHEDULER_TOKEN", TOKEN);
});

describe("previewCdnCgiGuard", () => {
  it("leaves app routes to the worker", () => {
    expect(guard()("/mcp")).toBe("passed");
  });

  it.each([
    ["/cdn-cgi/local/r2/public/open-seo/dataforseo-cache/x", {}],
    ["/cdn-cgi/handler/scheduled?cron=*", {}],
    ["//evil.test/cdn-cgi/handler/scheduled", {}],
    [
      "/cdn-cgi/handler/scheduled",
      { "x-openseo-scheduler-token": "w".repeat(64) },
    ],
    ["/cdn-cgi/mf/scheduled", { "x-openseo-scheduler-token": TOKEN }],
  ])("blocks %s without the scheduler token", (url, headers) => {
    expect(guard()(url, headers)).toBe(404);
  });

  it("lets the scheduler trigger the scheduled handler", () => {
    expect(
      guard()("/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*", {
        "x-openseo-scheduler-token": TOKEN,
      }),
    ).toBe("passed");
  });
});
