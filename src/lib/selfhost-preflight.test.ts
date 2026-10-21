import { describe, expect, it } from "vitest";
import { runSelfhostPreflight, seoDataProviders } from "./selfhost-preflight";

function itemFor(
  result: ReturnType<typeof runSelfhostPreflight>,
  name: string,
) {
  return result.items.find((item) => item.name === name);
}

describe("runSelfhostPreflight", () => {
  it("passes the stock Docker setup (local_noauth + DataForSEO key)", () => {
    const result = runSelfhostPreflight({
      AUTH_MODE: "local_noauth",
      DATAFORSEO_API_KEY: btoa("user@example.com:secret"),
    });

    expect(result.failed).toBe(false);
    expect(itemFor(result, "AUTH_MODE")?.level).toBe("ok");
    expect(itemFor(result, "DATAFORSEO_API_KEY")?.level).toBe("ok");
  });

  it("fails an invalid AUTH_MODE with the valid list", () => {
    const result = runSelfhostPreflight({ AUTH_MODE: "local-noauth" });

    expect(result.failed).toBe(true);
    expect(itemFor(result, "AUTH_MODE")?.message).toContain(
      "cloudflare_access, local_noauth, hosted",
    );
  });

  it.each([
    [{}, ["TEAM_DOMAIN and POLICY_AUD", "AUTH_MODE is unset"]],
    [
      { AUTH_MODE: "hosted", BETTER_AUTH_SECRET: "x".repeat(40) },
      ["BETTER_AUTH_URL", "GOOGLE_CLIENT_ID"],
    ],
  ])("fails %o listing every missing variable", (env, mentions) => {
    const result = runSelfhostPreflight(env);

    expect(result.failed).toBe(true);
    const message = itemFor(result, "AUTH_MODE")?.message;
    for (const mention of mentions) expect(message).toContain(mention);
    expect(message).not.toContain("BETTER_AUTH_SECRET,");
  });

  it.each(["short-key", `${"k".repeat(32)}+/=`])(
    "fails SELFHOST_ACCESS_KEY %s without echoing it",
    (key) => {
      const result = runSelfhostPreflight({
        AUTH_MODE: "local_noauth",
        SELFHOST_ACCESS_KEY: key,
      });

      expect(result.failed).toBe(true);
      expect(itemFor(result, "AUTH_MODE")?.message).not.toContain(key);
    },
  );

  // The runtime keeps DataForSEO to backlinks for any value; the startup check
  // stops on a typo so the operator sees it.
  it("fails a DATAFORSEO_SCOPE typo", () => {
    const result = runSelfhostPreflight({
      AUTH_MODE: "local_noauth",
      DATAFORSEO_API_KEY: btoa("user@example.com:secret"),
      DATAFORSEO_SCOPE: "backlink",
    });

    expect(result.failed).toBe(true);
    expect(itemFor(result, "DATAFORSEO_SCOPE")?.level).toBe("fail");
  });

  it("warns that GSC stays disabled on a short BETTER_AUTH_SECRET", () => {
    const result = runSelfhostPreflight({
      AUTH_MODE: "local_noauth",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      BETTER_AUTH_SECRET: "too-short",
    });

    expect(itemFor(result, "Search Console")?.level).toBe("warn");
    expect(itemFor(result, "Search Console")?.message).toContain("32");
  });
});

// The app shell asks for setup only when this finds nothing at all, so a
// stand-in must count only where it actually runs.
describe("seoDataProviders", () => {
  const key = btoa("user@example.com:secret");
  const places = { GOOGLE_PLACES_API_KEY: "places-key" };

  it.each([
    [
      "DataForSEO for everything hides the stand-ins",
      { DATAFORSEO_API_KEY: key, ...places },
      { dataforseo: "all", standIns: [] },
    ],
    [
      "hosted ignores the scope and never runs stand-ins",
      {
        AUTH_MODE: "hosted",
        DATAFORSEO_API_KEY: key,
        DATAFORSEO_SCOPE: "backlinks",
        ...places,
      },
      { dataforseo: "all", standIns: [] },
    ],
    [
      "the backlinks scope keeps the stand-ins",
      { DATAFORSEO_API_KEY: key, DATAFORSEO_SCOPE: "backlinks", ...places },
      {
        dataforseo: "backlinks",
        standIns: [expect.stringContaining("Places")],
      },
    ],
    ["nothing set up", {}, { dataforseo: null, standIns: [] }],
  ])("%s", (_name, env, expected) => {
    expect(seoDataProviders(env)).toEqual(expected);
  });
});
