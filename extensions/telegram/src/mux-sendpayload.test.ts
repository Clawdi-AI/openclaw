import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "./channel.js";
import { setTelegramRuntime } from "./runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telegram extension mux outbound sendPayload", () => {
  it("telegram sendPayload passes buttons and mux opts through to sendTelegram", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({
      messageId: "mx-tg-1",
      chatId: "tg-chat-1",
    });

    const cfg = {
      gateway: {
        http: {
          endpoints: {
            mux: {
              baseUrl: "http://mux.local",
              registerKey: "test-register-key",
              inboundUrl: "http://openclaw.local/v1/mux/inbound",
            },
          },
        },
      },
      channels: {
        telegram: {
          accounts: {
            mux: {
              mux: {
                enabled: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = await telegramPlugin.outbound?.sendPayload?.({
      cfg,
      to: "telegram:123",
      text: "ignored",
      accountId: "mux",
      sessionKey: "sess-tg",
      deps: { sendTelegram },
      payload: {
        text: "hello",
        channelData: {
          telegram: {
            buttons: [[{ text: "Next", callback_data: "commands_page_2:main" }]],
          },
        },
      },
    });

    expect(result).toMatchObject({ channel: "telegram", messageId: "mx-tg-1" });
    expect(sendTelegram).toHaveBeenCalledOnce();
    expect(sendTelegram).toHaveBeenCalledWith(
      "telegram:123",
      "hello",
      expect.objectContaining({
        mux: { cfg, sessionKey: "sess-tg" },
        buttons: [[{ text: "Next", callback_data: "commands_page_2:main" }]],
      }),
    );
  });

  it("telegram sendPoll passes mux opts through to sendPollTelegram", async () => {
    const sendPollTelegram = vi.fn().mockResolvedValue({
      messageId: "mx-tg-poll-1",
      chatId: "tg-chat-1",
      pollId: "poll-1",
    });

    setTelegramRuntime({
      channel: {
        telegram: {
          sendPollTelegram,
        },
      },
    } as PluginRuntime);

    const cfg = {
      gateway: {
        http: {
          endpoints: {
            mux: {
              baseUrl: "http://mux.local",
              registerKey: "test-register-key",
              inboundUrl: "http://openclaw.local/v1/mux/inbound",
            },
          },
        },
      },
      channels: {
        telegram: {
          accounts: {
            mux: {
              mux: {
                enabled: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = await telegramPlugin.outbound?.sendPoll?.({
      cfg,
      to: "telegram:123",
      poll: {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
      },
      accountId: "mux",
      sessionKey: "sess-tg",
      threadId: "42",
      silent: true,
      isAnonymous: false,
    });

    expect(result).toMatchObject({ messageId: "mx-tg-poll-1", pollId: "poll-1" });
    expect(sendPollTelegram).toHaveBeenCalledOnce();
    expect(sendPollTelegram).toHaveBeenCalledWith(
      "telegram:123",
      {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
      },
      expect.objectContaining({
        accountId: "mux",
        messageThreadId: 42,
        silent: true,
        isAnonymous: false,
        mux: { cfg, sessionKey: "sess-tg" },
      }),
    );
  });
});
