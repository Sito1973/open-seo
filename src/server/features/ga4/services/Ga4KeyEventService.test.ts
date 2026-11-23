import { beforeEach, describe, expect, it, vi } from "vitest";
import { GA4_EDIT_SCOPE } from "@/shared/ga4";
import { makeGa4Connection } from "./ga4-test-fixtures";
import { Ga4KeyEventService } from "./Ga4KeyEventService";

const mocks = vi.hoisted(() => ({
  getByProjectId: vi.fn(),
  getGrantedScopes: vi.fn(),
  listKeyEvents: vi.fn(),
  createKeyEvent: vi.fn(),
  deleteKeyEvent: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: { getByProjectId: mocks.getByProjectId },
}));
vi.mock("@/server/features/google/GoogleAccountRepository", () => ({
  GoogleAccountRepository: { getGrantedScopes: mocks.getGrantedScopes },
}));
vi.mock("@/server/lib/ga4Client", () => ({
  createGa4AdminClient: () => ({
    listKeyEvents: mocks.listKeyEvents,
    createKeyEvent: mocks.createKeyEvent,
    deleteKeyEvent: mocks.deleteKeyEvent,
  }),
}));

const mark = {
  projectId: "project_1",
  eventName: "generate_lead",
  remove: false,
  countingMethod: "ONCE_PER_EVENT" as const,
  apply: true,
};

describe("Ga4KeyEventService", () => {
  beforeEach(() => {
    mocks.getByProjectId.mockResolvedValue(makeGa4Connection());
    mocks.getGrantedScopes.mockResolvedValue([GA4_EDIT_SCOPE]);
    mocks.listKeyEvents.mockResolvedValue([
      {
        name: "properties/123/keyEvents/9",
        eventName: "purchase",
        countingMethod: "ONCE_PER_SESSION",
      },
    ]);
  });

  it("previews without writing and says when the grant cannot edit", async () => {
    mocks.getGrantedScopes.mockResolvedValue([]);

    const result = await Ga4KeyEventService.updateKeyEvent({
      ...mark,
      apply: false,
    });

    expect(result).toMatchObject({
      mode: "preview",
      canApply: false,
      changes: [{ before: null, after: "ONCE_PER_EVENT" }],
    });
    expect(mocks.createKeyEvent).not.toHaveBeenCalled();
  });

  it("refuses to apply on a read-only grant", async () => {
    mocks.getGrantedScopes.mockResolvedValue([]);

    await expect(Ga4KeyEventService.updateKeyEvent(mark)).rejects.toMatchObject(
      { code: "ga4_reconnect_required" },
    );
    expect(mocks.createKeyEvent).not.toHaveBeenCalled();
  });

  it("marks the event and returns the arguments that undo it", async () => {
    const result = await Ga4KeyEventService.updateKeyEvent(mark);

    expect(mocks.createKeyEvent).toHaveBeenCalledWith("properties/123", {
      eventName: "generate_lead",
      countingMethod: "ONCE_PER_EVENT",
    });
    expect(result).toMatchObject({
      mode: "applied",
      revert: { eventName: "generate_lead", remove: true },
    });
  });

  it("removes a mark by its resource name and can restore its counting method", async () => {
    const result = await Ga4KeyEventService.updateKeyEvent({
      ...mark,
      eventName: "purchase",
      remove: true,
    });

    expect(mocks.deleteKeyEvent).toHaveBeenCalledWith(
      "properties/123/keyEvents/9",
    );
    expect(result.revert).toEqual({
      eventName: "purchase",
      countingMethod: "ONCE_PER_SESSION",
    });
  });

  it("writes nothing when the event is already a key event", async () => {
    const result = await Ga4KeyEventService.updateKeyEvent({
      ...mark,
      eventName: "purchase",
    });

    expect(result).toMatchObject({ mode: "unchanged", changes: [] });
    expect(mocks.createKeyEvent).not.toHaveBeenCalled();
  });
});
