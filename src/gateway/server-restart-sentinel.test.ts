import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeRestartSentinel: vi.fn(),
  loadSessionEntry: vi.fn(),
  deliverOutboundPayloads: vi.fn(async () => []),
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "123" })),
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/restart-sentinel.js")>(
    "../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    consumeRestartSentinel: mocks.consumeRestartSentinel,
  };
});

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/targets.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/outbound/targets.js")>(
    "../infra/outbound/targets.js",
  );
  return {
    ...actual,
    resolveOutboundTarget: mocks.resolveOutboundTarget,
  };
});

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

describe("scheduleRestartSentinelWake", () => {
  beforeEach(() => {
    mocks.consumeRestartSentinel.mockReset();
    mocks.loadSessionEntry.mockReset();
    mocks.deliverOutboundPayloads.mockReset();
    mocks.resolveOutboundTarget.mockReset();
    mocks.enqueueSystemEvent.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([]);
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "123" });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {} as never,
      entry: {
        lastChannel: "telegram",
        lastTo: "123",
        lastAccountId: "mux",
      },
    });
  });

  it("passes the source sessionKey into direct restart delivery", async () => {
    mocks.consumeRestartSentinel.mockResolvedValue({
      payload: {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        sessionKey: "agent:main:telegram:direct:123",
      },
    });

    const { scheduleRestartSentinelWake } = await import("./server-restart-sentinel.js");
    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
  });
});
