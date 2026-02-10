import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { discordOutbound } from "./discord.js";
import { telegramOutbound } from "./telegram.js";
import { whatsappOutbound } from "./whatsapp.js";

const originalFetch = globalThis.fetch;
const TENANT_TOKEN = "tenant-key";

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function gatewayMuxConfig(): Pick<OpenClawConfig, "gateway"> {
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

describe("mux outbound routing", () => {
  it("routes telegram outbound through mux when enabled", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ messageId: "mx-tg-1", chatId: "tg-chat-1" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sendTelegram = vi.fn();
    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        telegram: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    const result = await telegramOutbound.sendText!({
      cfg,
      to: "telegram:123",
      text: "hello",
      sessionKey: "sess-tg",
      deps: { sendTelegram },
    });

    expect(sendTelegram).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      channel: "telegram",
      messageId: "mx-tg-1",
      chatId: "tg-chat-1",
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://mux.local/v1/mux/outbound/send");
    expect(init.headers).toEqual(
      expect.objectContaining({ Authorization: `Bearer ${TENANT_TOKEN}` }),
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      channel: "telegram",
      sessionKey: "sess-tg",
      to: "telegram:123",
      text: "hello",
    });
  });

  it("routes discord outbound through mux when enabled", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ messageId: "mx-discord-1", channelId: "dc-channel-1" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sendDiscord = vi.fn();
    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        discord: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    const result = await discordOutbound.sendText!({
      cfg,
      to: "discord:chan",
      text: "hello",
      sessionKey: "sess-discord",
      deps: { sendDiscord },
    });

    expect(sendDiscord).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      channel: "discord",
      messageId: "mx-discord-1",
      channelId: "dc-channel-1",
    });
  });

  it("routes whatsapp outbound through mux when enabled", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ messageId: "mx-wa-1", toJid: "jid-1" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sendWhatsApp = vi.fn();
    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        whatsapp: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    const result = await whatsappOutbound.sendText!({
      cfg,
      to: "+15555550100",
      text: "hello",
      sessionKey: "sess-wa",
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ channel: "whatsapp", messageId: "mx-wa-1", toJid: "jid-1" });
  });

  it("routes telegram outbound through mux from default account config", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ messageId: "mx-tg-acct-1" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        telegram: {
          accounts: {
            default: {
              mux: {
                enabled: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await telegramOutbound.sendText!({
      cfg,
      to: "telegram:123",
      text: "hello",
      sessionKey: "sess-tg",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("routes discord outbound through mux from default account config", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ messageId: "mx-discord-acct-1" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        discord: {
          accounts: {
            default: {
              mux: {
                enabled: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await discordOutbound.sendText!({
      cfg,
      to: "discord:chan",
      text: "hello",
      sessionKey: "sess-discord",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("routes whatsapp outbound through mux from default account config", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ messageId: "mx-wa-acct-1" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        whatsapp: {
          accounts: {
            default: {
              mux: {
                enabled: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await whatsappOutbound.sendText!({
      cfg,
      to: "+15555550100",
      text: "hello",
      sessionKey: "sess-wa",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("requires gateway mux token when channel mux is enabled", async () => {
    const cfg = {
      gateway: {
        http: {
          endpoints: {
            mux: {
              baseUrl: "http://mux.local",
            },
          },
        },
      },
      channels: {
        telegram: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      telegramOutbound.sendText!({
        cfg,
        to: "telegram:123",
        text: "hello",
        sessionKey: "sess-tg",
      }),
    ).rejects.toThrow(/gateway\.http\.endpoints\.mux\.token is required/i);
  });

  it("requires gateway mux baseUrl when channel mux is enabled", async () => {
    const cfg = {
      gateway: {
        http: {
          endpoints: {
            mux: {
              token: TENANT_TOKEN,
            },
          },
        },
      },
      channels: {
        telegram: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      telegramOutbound.sendText!({
        cfg,
        to: "telegram:123",
        text: "hello",
        sessionKey: "sess-tg",
      }),
    ).rejects.toThrow(/gateway\.http\.endpoints\.mux\.baseUrl is required/i);
  });

  it("rejects telegram mux success payload missing messageId", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ chatId: "tg-chat-1" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        telegram: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      telegramOutbound.sendText!({
        cfg,
        to: "telegram:123",
        text: "hello",
        sessionKey: "sess-tg",
      }),
    ).rejects.toThrow(/missing messageId/i);
  });

  it("rejects discord mux success payload missing messageId", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ channelId: "dc-channel-1" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        discord: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      discordOutbound.sendText!({
        cfg,
        to: "discord:chan",
        text: "hello",
        sessionKey: "sess-discord",
      }),
    ).rejects.toThrow(/missing messageId/i);
  });

  it("rejects whatsapp mux success payload missing messageId", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ toJid: "jid-1" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        whatsapp: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      whatsappOutbound.sendText!({
        cfg,
        to: "+15555550100",
        text: "hello",
        sessionKey: "sess-wa",
      }),
    ).rejects.toThrow(/missing messageId/i);
  });
});
