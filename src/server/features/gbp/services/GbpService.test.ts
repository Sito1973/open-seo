import { beforeEach, expect, it, vi } from "vitest";
import { GbpService } from "./GbpService";

const mocks = vi.hoisted(() => ({
  listGrantsForUser: vi.fn(),
  upsert: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/google/googleOAuth", () => ({
  getGoogleAccessToken: async () => "access-token",
}));
vi.mock("@/server/features/gbp/repositories/GbpConnectionRepository", () => ({
  GbpConnectionRepository: {
    listGrantsForUser: mocks.listGrantsForUser,
    upsert: mocks.upsert,
  },
}));

beforeEach(() => {
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.listGrantsForUser.mockResolvedValue([{ accountId: "google-sub" }]);
  mocks.fetch.mockImplementation(async () =>
    Response.json({
      accounts: [
        { name: "accounts/1", accountName: "Owner", type: "PERSONAL" },
      ],
    }),
  );
});

it("refuses a Business Profile account the user's grant does not list", async () => {
  await expect(
    GbpService.setAccount({
      projectId: "project_1",
      organizationId: "org_1",
      userId: "user_1",
      accountId: "google-sub",
      accountName: "accounts/999",
    }),
  ).rejects.toThrow(
    "That Business Profile account isn't available on your connected Google account.",
  );
  expect(mocks.upsert).not.toHaveBeenCalled();
});
