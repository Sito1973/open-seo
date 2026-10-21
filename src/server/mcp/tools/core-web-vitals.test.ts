import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { getCoreWebVitalsTool } from "./core-web-vitals";
import { makeToolContext, textContent } from "./tool-test-support";

// A self-hosted install with GOOGLE_PAGESPEED_API_KEY and no DataForSEO key.

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();
const period = (day: number) => ({
  firstDate: { year: 2026, month: 9, day },
  lastDate: { year: 2026, month: 10, day },
});

const requestBodySchema = z.looseObject({ origin: z.string() });

beforeEach(() => {
  vi.stubEnv("DATAFORSEO_API_KEY", "");
  vi.stubEnv("AUTH_MODE", "");
  vi.stubEnv("GOOGLE_PAGESPEED_API_KEY", "psi-key");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    domain: "bandidos.co",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function readRequest(url: Parameters<typeof fetch>[0], init?: RequestInit) {
  const body: unknown =
    typeof init?.body === "string" ? JSON.parse(init.body) : null;
  return {
    url: typeof url === "string" ? url : "",
    apiKey: new Headers(init?.headers).get("X-Goog-Api-Key"),
    body: requestBodySchema.parse(body),
  };
}

/** Answers each endpoint and origin from `answers`; anything else is CrUX's 404. */
function cruxAnswers(answers: Record<string, unknown>) {
  mocks.fetch.mockImplementation(async (url, init) => {
    const request = readRequest(url, init);
    const answer =
      answers[`${request.url.split(":").at(-1)} ${request.body.origin}`];
    return answer
      ? Response.json(answer)
      : Response.json(
          { error: { code: 404, message: "chrome ux report data not found" } },
          { status: 404 },
        );
  });
}

function sentRequests() {
  return mocks.fetch.mock.calls.map(([url, init]) => readRequest(url, init));
}

it("retries a bare apex domain on www and reports a target CrUX lacks as no field data", async () => {
  cruxAnswers({
    "queryRecord https://www.bandidos.co": {
      record: {
        key: { origin: "https://www.bandidos.co" },
        metrics: {
          largest_contentful_paint: {
            histogram: [{ density: 0.7 }, { density: 0.2 }, { density: 0.1 }],
            percentiles: { p75: 3100 },
          },
          cumulative_layout_shift: { percentiles: { p75: "0.05" } },
        },
        collectionPeriod: period(18),
      },
    },
  });

  const result = await getCoreWebVitalsTool.handler(
    {
      projectId: "project_1",
      targets: ["bandidos.co", "https://rival.co"],
      device: "phone",
    },
    toolContext,
  );

  const requests = sentRequests();
  expect(requests).toHaveLength(3);
  expect(new Set(requests.map((request) => request.body.origin))).toEqual(
    new Set([
      "https://bandidos.co",
      "https://www.bandidos.co",
      "https://rival.co",
    ]),
  );
  for (const request of requests) {
    expect(request).toMatchObject({
      url: "https://chromeuxreport.googleapis.com/v1/records:queryRecord",
      apiKey: "psi-key",
      body: { formFactor: "PHONE" },
    });
  }
  expect(result.structuredContent.rows).toMatchObject([
    {
      target: "bandidos.co",
      hasData: true,
      key: "https://www.bandidos.co",
      coreWebVitals: "failed",
      metrics: {
        lcp: {
          p75: 3100,
          rating: "needs_improvement",
          good: 0.7,
          needsImprovement: 0.2,
          poor: 0.1,
        },
        cls: { p75: 0.05, rating: "good" },
        inp: null,
      },
    },
    { target: "https://rival.co", hasData: false, tried: ["https://rival.co"] },
  ]);
  expect(textContent(result)).toContain(
    "https://rival.co (phone): no field data",
  );
});

it("returns weekly history with weeks CrUX lacks as null, not 0", async () => {
  cruxAnswers({
    "queryRecord https://www.bandidos.co": {
      record: {
        key: { origin: "https://www.bandidos.co" },
        collectionPeriod: period(18),
      },
    },
    "queryHistoryRecord https://www.bandidos.co": {
      record: {
        metrics: {
          largest_contentful_paint: {
            percentilesTimeseries: { p75s: [2900, null] },
          },
          cumulative_layout_shift: {
            percentilesTimeseries: { p75s: ["0.04", "0.06"] },
          },
        },
        collectionPeriods: [period(4), period(11)],
      },
    },
  });

  const result = await getCoreWebVitalsTool.handler(
    {
      projectId: "project_1",
      targets: ["https://www.bandidos.co"],
      device: "all",
      historyWeeks: 2,
    },
    toolContext,
  );

  const historyRequest = sentRequests().find((request) =>
    request.url.endsWith(":queryHistoryRecord"),
  );
  // "all" combines every device, which CrUX reads as no formFactor.
  expect(historyRequest?.body).toMatchObject({ collectionPeriodCount: 2 });
  expect(historyRequest?.body).not.toHaveProperty("formFactor");
  expect(result.structuredContent.rows).toMatchObject([
    {
      history: [
        { windowEnd: "2026-10-04", lcp: 2900, cls: 0.04, inp: null },
        { windowEnd: "2026-10-11", lcp: null, cls: 0.06, inp: null },
      ],
    },
  ]);
});
