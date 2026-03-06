import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(async () => []),
  getChannelPlugin: vi.fn(() => ({})),
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "123" })),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (value: string) => value,
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

describe("deliverAgentCommandResult", () => {
  beforeEach(() => {
    mocks.deliverOutboundPayloads.mockReset();
    mocks.resolveOutboundTarget.mockReset();
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "123" });
  });

  it("passes sessionKey through direct outbound delivery", async () => {
    const cfg = {} as OpenClawConfig;
    const deps = {} as CliDeps;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
    const result = {
      payloads: [{ text: "hello" }],
      meta: { durationMs: 1 },
    };

    const { deliverAgentCommandResult } = await import("./agent/delivery.js");
    await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts: {
        message: "hello",
        deliver: true,
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        to: "123",
      } as never,
      sessionEntry: {
        lastChannel: "telegram",
        lastTo: "123",
      } as SessionEntry,
      result: result as never,
      payloads: result.payloads,
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:telegram:direct:123" }),
    );
  });
});
