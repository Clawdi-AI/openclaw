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

  function buildMuxFetchSpy() {
    const outboundSends: Array<Record<string, unknown>> = [];
    const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
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
        outboundSends.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ messageId: "mx-im-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    return { spy, outboundSends };
  }

  function buildMuxEnabledCfg(overrides?: Record<string, unknown>) {
    return {
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
          ...(overrides ?? {}),
        },
      },
    };
  }

  it("routes sendText through mux with full body (replyToId, sessionKey, raw.imessage.send)", async () => {
    const { spy, outboundSends } = buildMuxFetchSpy();
    globalThis.fetch = spy as unknown as typeof fetch;

    const sendIMessage = vi.fn();
    const result = await imessagePlugin.outbound!.sendText!({
      cfg: buildMuxEnabledCfg(),
      to: "chat_guid:abc",
      text: "hello",
      accountId: "default",
      sessionKey: "sess-im",
      replyToId: "target-msg-1",
      deps: { sendIMessage },
    });

    expect(sendIMessage).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ channel: "imessage", messageId: "mx-im-1" });
    expect(outboundSends).toHaveLength(1);
    const body = outboundSends[0];
    expect(body).toMatchObject({
      channel: "imessage",
      sessionKey: "sess-im",
      to: "chat_guid:abc",
      text: "hello",
      replyToId: "target-msg-1",
    });
    expect(body.raw).toMatchObject({ imessage: { send: { text: "hello" } } });
  });

  it("routes sendMedia through mux with mediaUrl + replyToId in body", async () => {
    const { spy, outboundSends } = buildMuxFetchSpy();
    globalThis.fetch = spy as unknown as typeof fetch;

    const sendIMessage = vi.fn();
    const result = await imessagePlugin.outbound!.sendMedia!({
      cfg: buildMuxEnabledCfg(),
      to: "chat_guid:abc",
      text: "caption",
      mediaUrl: "https://cdn.example.com/pic.png",
      accountId: "default",
      sessionKey: "sess-im",
      replyToId: "target-msg-42",
      deps: { sendIMessage },
    });

    expect(sendIMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "imessage", messageId: "mx-im-1" });
    const body = outboundSends[0];
    expect(body).toMatchObject({
      channel: "imessage",
      sessionKey: "sess-im",
      to: "chat_guid:abc",
      text: "caption",
      mediaUrl: "https://cdn.example.com/pic.png",
      replyToId: "target-msg-42",
    });
    expect(body.raw).toMatchObject({
      imessage: { send: { text: "caption", mediaUrl: "https://cdn.example.com/pic.png" } },
    });
  });

  // Mux for iMessage is scoped to the default business account — one Photon
  // number serves all tenants. Non-default accountIds must bypass mux and fall
  // through to the native provider path (which currently no-ops because
  // startAccount skips native provider startup when mux is enabled at channel
  // level). The test captures this scoping so a future refactor that
  // accidentally widens the gate is caught.
  it("non-default accountId does NOT route through mux (native fallthrough)", async () => {
    const { spy, outboundSends } = buildMuxFetchSpy();
    globalThis.fetch = spy as unknown as typeof fetch;

    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "native-1" });
    await imessagePlugin.outbound!.sendText!({
      cfg: buildMuxEnabledCfg(),
      to: "chat_guid:abc",
      text: "hi",
      accountId: "secondary",
      sessionKey: "sess-im",
      deps: { sendIMessage },
    });

    // No mux outbound POST happened — only the register (if any) could fire,
    // but with non-default account we should also skip instance registration.
    expect(outboundSends).toHaveLength(0);
    // Native provider call DID happen.
    expect(sendIMessage).toHaveBeenCalledTimes(1);
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
