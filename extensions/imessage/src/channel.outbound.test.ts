import { describe, expect, it, vi } from "vitest";
import { imessagePlugin } from "./channel.js";
import { setIMessageRuntime } from "./runtime.js";

const createLogSink = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

describe("imessagePlugin outbound", () => {
  const cfg = {
    channels: {
      imessage: {
        mediaMaxMb: 3,
      },
    },
  };

  it("forwards replyToId on direct sendText adapter path", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "m-text" });
    const sendText = imessagePlugin.outbound?.sendText;
    expect(sendText).toBeDefined();

    const result = await sendText!({
      cfg,
      to: "chat_id:12",
      text: "hello",
      accountId: "default",
      replyToId: "reply-1",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:12",
      "hello",
      expect.objectContaining({
        accountId: "default",
        replyToId: "reply-1",
        maxBytes: 3 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "m-text" });
  });

  it("forwards replyToId on direct sendMedia adapter path", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "m-media" });
    const sendMedia = imessagePlugin.outbound?.sendMedia;
    expect(sendMedia).toBeDefined();

    const result = await sendMedia!({
      cfg,
      to: "chat_id:77",
      text: "caption",
      mediaUrl: "https://example.com/pic.png",
      accountId: "acct-1",
      replyToId: "reply-2",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:77",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/pic.png",
        accountId: "acct-1",
        replyToId: "reply-2",
        maxBytes: 3 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "m-media" });
  });

  it("forwards mediaLocalRoots on direct sendMedia adapter path", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "m-media-local" });
    const sendMedia = imessagePlugin.outbound?.sendMedia;
    expect(sendMedia).toBeDefined();
    const mediaLocalRoots = ["/tmp/workspace"];

    const result = await sendMedia!({
      cfg,
      to: "chat_id:88",
      text: "caption",
      mediaUrl: "/tmp/workspace/pic.png",
      mediaLocalRoots,
      accountId: "acct-1",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:88",
      "caption",
      expect.objectContaining({
        mediaUrl: "/tmp/workspace/pic.png",
        mediaLocalRoots,
        accountId: "acct-1",
        maxBytes: 3 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "m-media-local" });
  });

  it("routes sendText through mux when enabled", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "http://mux.local/v1/instances/register") {
        return new Response(
          JSON.stringify({
            ok: true,
            runtimeToken: "runtime-token",
            expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        expect(init?.body).toBeDefined();
        return new Response(JSON.stringify({ messageId: "mx-im-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sendIMessage = vi.fn();
    const result = await imessagePlugin.outbound!.sendText!({
      cfg: {
        gateway: {
          http: {
            endpoints: {
              mux: {
                baseUrl: "http://mux.local",
                inboundUrl: "http://gateway.local/mux/inbound",
                registerKey: "register-key",
              },
            },
          },
        },
        channels: {
          imessage: {
            mux: { enabled: true },
          },
        },
      },
      to: "chat_guid:abc",
      text: "hello",
      accountId: "default",
      sessionKey: "sess-im",
      deps: { sendIMessage },
    });

    expect(sendIMessage).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ channel: "imessage", messageId: "mx-im-1" });
  });

  it("skips native provider startup when mux is enabled", async () => {
    const monitorIMessageProvider = vi.fn(async () => undefined);
    setIMessageRuntime({
      channel: {
        imessage: {
          sendMessageIMessage: vi.fn(),
          probeIMessage: vi.fn(),
          monitorIMessageProvider,
        },
        text: {
          chunkText: (text: string) => [text],
        },
      },
      logging: {
        shouldLogVerbose: () => false,
      },
    } as never);

    const abortController = new AbortController();
    const log = createLogSink();
    const startPromise = imessagePlugin.gateway!.startAccount!({
      cfg: {
        channels: {
          imessage: {
            mux: { enabled: true },
          },
        },
      } as never,
      accountId: "default",
      account: imessagePlugin.config.resolveAccount(
        {
          channels: {
            imessage: {
              mux: { enabled: true },
            },
          },
        } as never,
        "default",
      ),
      runtime: {} as never,
      abortSignal: abortController.signal,
      log,
      getStatus: () => ({ accountId: "default" }) as never,
      setStatus: vi.fn(),
    });

    let resolved = false;
    void startPromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(monitorIMessageProvider).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "[default] mux enabled; skipping native provider startup",
    );
    expect(resolved).toBe(false);

    abortController.abort();
    await startPromise;
    expect(resolved).toBe(true);
  });
});
