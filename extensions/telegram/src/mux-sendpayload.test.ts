import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../../discord/src/channel.js";
import { whatsappPlugin } from "../../whatsapp/src/channel.js";
import { telegramPlugin } from "./channel.js";

const originalFetch = globalThis.fetch;
const TENANT_TOKEN = "tenant-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function baseMuxGatewayConfig(): Pick<OpenClawConfig, "gateway"> {
  return {
    gateway: {
      http: {
        endpoints: {
          mux: {
            baseUrl: "http://mux.local",
            token: TENANT_TOKEN,
          },
        },
      },
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("extension mux outbound sendPayload", () => {
  it("telegram sendPayload passes channelData through mux", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ messageId: "mx-tg-1", chatId: "tg-chat-1" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...baseMuxGatewayConfig(),
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
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      channel?: string;
      sessionKey?: string;
      channelData?: Record<string, unknown>;
    };
    expect(body.channel).toBe("telegram");
    expect(body.sessionKey).toBe("sess-tg");
    expect(body.channelData).toEqual({
      telegram: {
        buttons: [[{ text: "Next", callback_data: "commands_page_2:main" }]],
      },
    });
  });

  it("discord sendPayload passes channelData through mux", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ messageId: "mx-discord-1", channelId: "dc-channel-1" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...baseMuxGatewayConfig(),
      channels: {
        discord: {
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

    const result = await discordPlugin.outbound?.sendPayload?.({
      cfg,
      to: "channel:123",
      text: "ignored",
      accountId: "mux",
      sessionKey: "sess-discord",
      payload: {
        text: "hello",
        channelData: {
          raw: {
            discord: {
              body: { content: "hello" },
            },
          },
        },
      },
    });

    expect(result).toMatchObject({ channel: "discord", messageId: "mx-discord-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      channel?: string;
      sessionKey?: string;
      channelData?: Record<string, unknown>;
      raw?: Record<string, unknown>;
    };
    expect(body.channel).toBe("discord");
    expect(body.sessionKey).toBe("sess-discord");
    expect(body.channelData).toEqual({
      raw: {
        discord: {
          body: { content: "hello" },
        },
      },
    });
    expect(body.raw).toEqual({
      discord: {
        body: { content: "hello" },
      },
    });
  });

  it("whatsapp sendPayload passes channelData and mediaUrls through mux", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ messageId: "mx-wa-1", toJid: "jid-1" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...baseMuxGatewayConfig(),
      channels: {
        whatsapp: {
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

    const result = await whatsappPlugin.outbound?.sendPayload?.({
      cfg,
      to: "+15555550100",
      text: "ignored",
      accountId: "mux",
      sessionKey: "sess-wa",
      payload: {
        text: "hello",
        mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
        channelData: {
          raw: {
            whatsapp: {
              body: { text: "hello" },
            },
          },
        },
      },
    });

    expect(result).toMatchObject({ channel: "whatsapp", messageId: "mx-wa-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      channel?: string;
      sessionKey?: string;
      mediaUrls?: string[];
      channelData?: Record<string, unknown>;
      raw?: Record<string, unknown>;
    };
    expect(body.channel).toBe("whatsapp");
    expect(body.sessionKey).toBe("sess-wa");
    expect(body.mediaUrls).toEqual(["https://example.com/a.jpg", "https://example.com/b.jpg"]);
    expect(body.channelData).toEqual({
      raw: {
        whatsapp: {
          body: { text: "hello" },
        },
      },
    });
    expect(body.raw).toEqual({
      whatsapp: {
        body: { text: "hello" },
      },
    });
  });
});
