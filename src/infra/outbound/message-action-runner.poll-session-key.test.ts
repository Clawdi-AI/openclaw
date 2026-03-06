import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

const mocks = vi.hoisted(() => ({
  executePollAction: vi.fn(),
}));

vi.mock("./outbound-send-service.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-send-service.js")>(
    "./outbound-send-service.js",
  );
  return {
    ...actual,
    executePollAction: (...args: unknown[]) => mocks.executePollAction(...args),
  };
});

import { runMessageAction } from "./message-action-runner.js";

describe("runMessageAction poll sessionKey propagation", () => {
  beforeEach(() => {
    mocks.executePollAction.mockReset();
    mocks.executePollAction.mockResolvedValue({
      handledBy: "core",
      payload: {},
      pollResult: undefined,
    });

    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "discord",
            capabilities: { chatTypes: ["channel"], polls: true },
            outbound: {
              deliveryMode: "direct",
              resolveTarget: ({ to }) => ({ ok: true, to: String(to ?? "") }),
              sendPoll: vi.fn(async () => ({ messageId: "p1" })),
            },
          }),
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("normalizes and forwards sessionKey to executePollAction", async () => {
    await runMessageAction({
      cfg: {},
      action: "poll",
      agentId: "main",
      sessionKey: "AGENT:MAIN:DISCORD:CHANNEL:C123",
      params: {
        channel: "discord",
        target: "channel:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
      },
    });

    expect(mocks.executePollAction).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          sessionKey: "agent:main:discord:channel:c123",
        }),
      }),
    );
  });
});
