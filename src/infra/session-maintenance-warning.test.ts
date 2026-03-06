import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(async () => []),
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("./system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

describe("deliverSessionMaintenanceWarning", () => {
  let prevVitest: string | undefined;
  let prevNodeEnv: string | undefined;

  beforeEach(() => {
    prevVitest = process.env.VITEST;
    prevNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
    mocks.deliverOutboundPayloads.mockReset();
    mocks.enqueueSystemEvent.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([]);
  });

  afterEach(() => {
    if (prevVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = prevVitest;
    }
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("passes sessionKey through direct warning delivery", async () => {
    const { deliverSessionMaintenanceWarning } = await import("./session-maintenance-warning.js");

    await deliverSessionMaintenanceWarning({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:telegram:direct:123",
      entry: {
        sessionId: "sid-1",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "123",
        lastAccountId: "mux",
      } as SessionEntry,
      warning: {
        activeSessionKey: "agent:main:telegram:direct:123",
        pruneAfterMs: 60_000,
        maxEntries: 100,
        wouldPrune: true,
        wouldCap: false,
      },
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
  });
});
