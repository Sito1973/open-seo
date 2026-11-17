import { vi, type Mock } from "vitest";

// Shared by the treg tool tests: a self-hosted install with TREG_API_KEY, and
// the requests its tools send to treg and to Meta's CDN.

type FetchMock = Mock<typeof fetch>;

/**
 * The defaults of every test: a self-hosted install with a treg key, the $2
 * budget with $0.50 of it spent, a project in Colombia, and no request
 * answered until the test says which.
 */
export function setUpTregInstall(mocks: {
  getProjectForOrganization: Mock;
  reserveCalls: Mock;
  adjustCalls: Mock;
  fetch: FetchMock;
}) {
  vi.stubEnv("AUTH_MODE", "");
  vi.stubEnv("TREG_API_KEY", "treg-key");
  vi.stubEnv("TREG_MONTHLY_BUDGET_USD", "");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    locationCode: 2170,
  });
  // A reservation adds the ceiling to the month's spend, and the correction
  // answers with what the month stands at afterwards.
  mocks.reserveCalls.mockImplementation(
    async ({ count }: { count: number }) => 500_000 + count,
  );
  mocks.adjustCalls.mockImplementation(
    async ({ delta }: { delta: number }) => 510_000 + delta,
  );
  answerWith(mocks.fetch, {});
}

/** treg's answer to one call, with the cost it reports in millionths of a dollar. */
export function tregResponse(body: unknown, costMicro: number) {
  return Response.json(body, {
    headers: { "X-Treg-Cost-Micro": String(costMicro) },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** Answers each URL from `routes`; any other request fails the test. */
export function answerWith(
  fetchMock: FetchMock,
  routes: Record<string, () => Response>,
) {
  fetchMock.mockImplementation(async (input) => {
    const url = requestUrl(input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route();
  });
}

/** Each request sent, with the headers that decide what treg may charge. */
export function sentRequests(fetchMock: FetchMock) {
  return fetchMock.mock.calls.map(([input, init]) => {
    const headers = new Headers(init?.headers);
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : null;
    return {
      url: requestUrl(input),
      token: headers.get("X-Treg-Token"),
      maxCost: headers.get("X-Treg-Route-Max-Cost"),
      waterfall: headers.get("X-Treg-Route-Waterfall"),
      redirect: init?.redirect,
      body,
    };
  });
}
