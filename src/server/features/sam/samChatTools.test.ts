import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tool } from "ai";
import { makeToolContext } from "@/server/mcp/tools/tool-test-support";
import {
  buildSamMcpTools,
  toModelOutput,
  waitingAuditStatusTool,
} from "./samChatTools";

vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {
    kind = "mock";
  },
}));

// The server-side wait in SAM's get_audit_status: a completed audit must
// return without waiting, and a running one must return as soon as the status
// line changes — a regression in either turns every status check into the
// full 50-second budget.

const running = (line: string) => ({
  summary: line,
  data: { status: { status: "running" } },
});
const completed = {
  summary: "done",
  data: { status: { status: "completed" } },
};

function buildTool(outputs: unknown[]) {
  const execute = vi.fn(() => Promise.resolve(outputs.shift()));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the wrapper only touches execute
  const tool = waitingAuditStatusTool(() => ({ execute }) as unknown as Tool);
  return { tool, execute };
}

const callOptions = { toolCallId: "t", messages: [] };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("waitingAuditStatusTool", () => {
  it("returns a finished audit without waiting", async () => {
    const { tool, execute } = buildTool([completed]);
    await expect(tool.execute?.({}, callOptions)).resolves.toBe(completed);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("waits while running and returns as soon as progress changes", async () => {
    vi.useFakeTimers();
    const { tool, execute } = buildTool([
      running("phase crawl, 3/56 pages"),
      running("phase crawl, 3/56 pages"),
      running("phase lighthouse, 56/56 pages"),
    ]);
    const call: unknown = tool.execute?.({}, callOptions);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(call).resolves.toMatchObject({
      summary: "phase lighthouse, 56/56 pages",
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });
});

describe("toModelOutput", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ keyword: `kw ${i}` }));
  const text = rows.map((row) => `| ${row.keyword} | 100 |`).join("\n");

  it("keeps only the head of the text when the structured data carries the rows", () => {
    const out = toModelOutput({
      content: [{ type: "text", text }],
      structuredContent: { rows },
    });
    expect(out.data).toEqual({ rows });
    expect(out.summary.length).toBeLessThan(text.length);
    expect(out.summary).toContain("(full rows in data)");
  });

  it("keeps the full text when structuredContent is only a meta deep link", () => {
    expect(
      toModelOutput({
        content: [{ type: "text", text }],
        structuredContent: { meta: { url: "https://example.com" } },
      }),
    ).toEqual({
      summary: text,
      data: { meta: { url: "https://example.com" } },
    });
  });
});

// SAM saves every tool result in its chat history, and Google's terms restrict
// storing Places content, so the tools that switch to Places must refuse.
it("refuses the local tools that would run on Google Places", async () => {
  vi.stubEnv("DATAFORSEO_API_KEY", "");
  vi.stubEnv("AUTH_MODE", "");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "places-key");
  const tools = buildSamMcpTools(makeToolContext().auth, {
    id: "project_1",
    domain: null,
  });

  for (const name of [
    "search_local_businesses",
    "get_local_serp_results",
    "get_local_rank_grid",
  ]) {
    await expect(
      tools[name]?.execute?.({}, callOptions),
    ).resolves.toHaveProperty(
      "error",
      expect.stringContaining("chat history is saved"),
    );
  }
});
