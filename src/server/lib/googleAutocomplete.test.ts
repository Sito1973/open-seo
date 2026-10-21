import { beforeEach, expect, it, vi } from "vitest";
import { fetchGoogleAutocomplete } from "./googleAutocomplete";

const mocks = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  fetch: vi.fn(),
  reserveCalls: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    R2: {
      get: async (key: string) => {
        const value = mocks.cache.get(key);
        return value === undefined ? null : { text: async () => value };
      },
      put: async (key: string, value: string) => mocks.cache.set(key, value),
    },
  },
}));
vi.mock(
  "@/server/features/google-places/repositories/GooglePlacesUsageRepository",
  () => ({
    GooglePlacesUsageRepository: { reserveCalls: mocks.reserveCalls },
  }),
);

beforeEach(() => {
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.reserveCalls.mockResolvedValue(1);
});

it("pauses every lookup after Google refuses one, while cached answers still count", async () => {
  mocks.fetch
    .mockResolvedValueOnce(
      Response.json(["hamburguesas", ["Hamburguesas Pereira"]]),
    )
    .mockResolvedValueOnce(new Response("", { status: 429 }));
  const market = { locationCode: 2170, languageCode: "es" };

  const first = await fetchGoogleAutocomplete({
    ...market,
    seed: "hamburguesas",
  });
  const again = await fetchGoogleAutocomplete({
    ...market,
    seed: "hamburguesas",
  });

  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(String(mocks.fetch.mock.calls[0][0])).toContain("hl=es-419&gl=co");
  for (const result of [first, again]) {
    expect(result.suggestions).toEqual(["hamburguesas pereira"]);
    expect(result.unavailable).toMatch(/paused until/);
  }
});
