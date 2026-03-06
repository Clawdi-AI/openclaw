import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  resolveOutboundTarget: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
  callGateway: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  normalizeChannelId: (channel?: string) => channel?.trim().toLowerCase() ?? undefined,
  getChannelPlugin: mocks.getChannelPlugin,
}));

vi.mock("./targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("./deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mocks.callGateway(...args),
  randomIdempotencyKey: () => "idem-1",
}));

import { sendMessage, sendPoll } from "./message.js";

describe("sendMessage", () => {
  beforeEach(() => {
    mocks.getChannelPlugin.mockReset();
    mocks.resolveOutboundTarget.mockReset();
    mocks.deliverOutboundPayloads.mockReset();
    mocks.callGateway.mockReset();

    mocks.getChannelPlugin.mockReturnValue({
      outbound: { deliveryMode: "direct" },
    });
    mocks.resolveOutboundTarget.mockImplementation(({ to }: { to: string }) => ({ ok: true, to }));
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "mattermost", messageId: "m1" }]);
  });

  it("passes explicit agentId to outbound delivery for scoped media roots", async () => {
    await sendMessage({
      cfg: {},
      channel: "mattermost",
      to: "channel:town-square",
      content: "hi",
      agentId: "work",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "work",
        channel: "mattermost",
        to: "channel:town-square",
      }),
    );
  });

  it("passes explicit sessionKey to direct outbound delivery without relying on mirror", async () => {
    await sendMessage({
      cfg: {},
      channel: "mattermost",
      to: "channel:town-square",
      content: "hi",
      sessionKey: "agent:main:discord:channel:123",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:discord:channel:123",
        mirror: undefined,
      }),
    );
  });

  it("passes explicit sessionKey to gateway sends without relying on mirror", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      outbound: { deliveryMode: "gateway" },
    });
    mocks.callGateway.mockResolvedValue({ messageId: "m-gw" });

    await sendMessage({
      cfg: {},
      channel: "mattermost",
      to: "channel:town-square",
      content: "hi",
      sessionKey: "agent:main:discord:channel:123",
    });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "send",
        params: expect.objectContaining({
          sessionKey: "agent:main:discord:channel:123",
        }),
      }),
    );
  });

  it("passes explicit sessionKey to gateway polls", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      outbound: {
        deliveryMode: "gateway",
        sendPoll: vi.fn(),
      },
    });
    mocks.callGateway.mockResolvedValue({ messageId: "p-gw" });

    await sendPoll({
      cfg: {},
      channel: "mattermost",
      to: "channel:town-square",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      sessionKey: "agent:main:discord:channel:123",
    });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "poll",
        params: expect.objectContaining({
          sessionKey: "agent:main:discord:channel:123",
        }),
      }),
    );
  });
});
