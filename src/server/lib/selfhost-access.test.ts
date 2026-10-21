import { describe, expect, it } from "vitest";
import { checkSelfHostAccess } from "./selfhost-access";

const KEY = "k".repeat(32);

function check(path: string, init?: RequestInit) {
  const url = new URL(path, "https://seo.example.com");
  return checkSelfHostAccess(new Request(url, init), url.pathname, KEY);
}

describe("checkSelfHostAccess", () => {
  it.each<[string, RequestInit]>([
    ["/", { headers: { Authorization: `Basic ${btoa(`me:${KEY}`)}` } }],
    ["/mcp", { method: "POST", headers: { Authorization: `Bearer ${KEY}` } }],
    [`/mcp?key=${KEY}`, { method: "POST" }],
  ])("lets %s through with the key", (path, init) => {
    expect(check(path, init)).toBeNull();
  });

  it("asks browsers for a Basic login and MCP clients for a Bearer key", () => {
    const page = check("/");
    expect(page?.status).toBe(401);
    expect(page?.headers.get("WWW-Authenticate")).toMatch(/^Basic/);

    const mcp = check("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    });
    expect(mcp?.status).toBe(401);
    expect(mcp?.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);
    expect(mcp?.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("accepts the query key on /mcp only", () => {
    expect(check(`/?key=${KEY}`)?.status).toBe(401);
  });

  it.each<[string, RequestInit]>([
    ["/api/health", {}],
    ["/api/health/", {}],
    ["/mcp", { method: "OPTIONS" }],
    ["/.well-known/oauth-protected-resource/mcp", {}],
  ])("leaves %s open", (path, init) => {
    expect(check(path, init)).toBeNull();
  });

  it("lets everything through when no key is set", () => {
    const request = new Request("https://seo.example.com/");
    expect(checkSelfHostAccess(request, "/", undefined)).toBeNull();
  });
});
