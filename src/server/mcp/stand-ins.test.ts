import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";
import { createWorkersOAuthMcpProps } from "./context";
import { createOpenSeoMcpServer } from "./server";

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn(),
  DurableObject: class {
    readonly ctx = null;
  },
}));

// Nothing bills credits where stand-ins run, so no tool may still claim it,
// and a tool whose section has no source here says so first.
it("replaces every credit claim on a server with stand-ins", async () => {
  const server = createOpenSeoMcpServer(
    createWorkersOAuthMcpProps({
      userId: "user_test",
      userEmail: "test@example.com",
      organizationId: "org_test",
      baseUrl: "https://open-seo.test",
    }),
    {
      selfHosted: true,
      standIns: {
        brightData: true,
        places: false,
        keywordPlanner: false,
        serpApi: false,
        openPageRank: false,
        pageSpeed: false,
        googleOAuth: false,
        model: false,
        ahrefs: false,
        dataforseoBacklinks: false,
      },
    },
  );
  const client = new Client({ name: "stand-in-descriptions", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const description = (name: string) =>
      tools.find((tool) => tool.name === name)?.description;

    expect(
      tools
        .filter((tool) => tool.description?.includes("Charges credits"))
        .map((tool) => tool.name),
    ).toEqual([]);
    expect(description("get_serp_results")).toContain(
      "one Bright Data request per 10 results of depth",
    );
    expect(description("get_domain_overview")).toContain(
      "PROVIDER_NOT_CONFIGURED",
    );
    expect(description("explore_prompt")).toMatch(
      /^Prompt Explorer has no source on this server/,
    );
    expect(client.getInstructions()).toContain("bills no credits");
  } finally {
    await client.close();
    await server.close();
  }
});
