import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  dispatchInboundMessage: vi.fn(async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: mocks.dispatchInboundMessage,
  };
});

const { handleMuxInboundHttpRequest } = await import("./mux-http.js");

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

function createRequest(params: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): IncomingMessage {
  const req = new Readable({
    read() {},
  }) as IncomingMessage;
  (req as { method?: string }).method = params.method ?? "POST";
  (req as { url?: string }).url = params.url ?? "/v1/mux/inbound";
  (req as { headers?: Record<string, string> }).headers = params.headers ?? {};
  if (params.body !== undefined) {
    const raw = typeof params.body === "string" ? params.body : JSON.stringify(params.body);
    req.push(raw);
  }
  req.push(null);
  return req;
}

function createResponse(): ServerResponse & { bodyText: string; headersMap: Map<string, string> } {
  const headersMap = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: unknown) {
      headersMap.set(name.toLowerCase(), String(value));
      return this;
    },
    end(chunk?: unknown) {
      this.bodyText = chunk == null ? "" : String(chunk);
      return this;
    },
    bodyText: "",
    headersMap,
  };
  return res as unknown as ServerResponse & { bodyText: string; headersMap: Map<string, string> };
}

afterEach(() => {
  mocks.loadConfig.mockReset();
  mocks.dispatchInboundMessage.mockClear();
});

describe("handleMuxInboundHttpRequest", () => {
  test("authenticates and dispatches inbound payload", async () => {
    mocks.loadConfig.mockReturnValue({
      gateway: {
        http: {
          endpoints: {
            mux: {
              enabled: true,
              token: "mux-secret",
            },
          },
        },
      },
    });

    const noAuthReq = createRequest({
      headers: { "content-type": "application/json" },
      body: {},
    });
    const noAuthRes = createResponse();
    expect(await handleMuxInboundHttpRequest(noAuthReq, noAuthRes)).toBe(true);
    expect(noAuthRes.statusCode).toBe(401);

    const missingChannelReq = createRequest({
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mux-secret",
      },
      body: {
        sessionKey: "main",
        to: "telegram:123",
        body: "hello",
      },
    });
    const missingChannelRes = createResponse();
    expect(await handleMuxInboundHttpRequest(missingChannelReq, missingChannelRes)).toBe(true);
    expect(missingChannelRes.statusCode).toBe(400);

    const okReq = createRequest({
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mux-secret",
      },
      body: {
        channel: "telegram",
        sessionKey: "main",
        to: "telegram:123",
        from: "telegram:user",
        body: "hello mux",
        messageId: "mux-msg-1",
      },
    });
    const okRes = createResponse();
    expect(await handleMuxInboundHttpRequest(okReq, okRes)).toBe(true);
    expect(okRes.statusCode).toBe(202);
    expect(JSON.parse(okRes.bodyText)).toEqual({ ok: true, eventId: "mux-msg-1" });

    expect(mocks.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const call = mocks.dispatchInboundMessage.mock.calls[0]?.[0] as
      | {
          ctx?: {
            Provider?: string;
            Surface?: string;
            OriginatingChannel?: string;
            OriginatingTo?: string;
            SessionKey?: string;
            MessageSid?: string;
            CommandAuthorized?: boolean;
          };
          replyOptions?: { images?: unknown[] };
        }
      | undefined;
    expect(call?.ctx).toMatchObject({
      Provider: "telegram",
      Surface: "mux",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:123",
      SessionKey: "main",
      MessageSid: "mux-msg-1",
      CommandAuthorized: true,
    });
    expect(call?.replyOptions?.images).toBeUndefined();
  });

  test("parses image attachments into replyOptions.images", async () => {
    mocks.loadConfig.mockReturnValue({
      gateway: {
        http: {
          endpoints: {
            mux: {
              enabled: true,
              token: "mux-secret",
            },
          },
        },
      },
    });

    const req = createRequest({
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mux-secret",
      },
      body: {
        channel: "telegram",
        sessionKey: "main",
        to: "telegram:123",
        body: "see image",
        messageId: "mux-img-1",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
          },
        ],
      },
    });
    const res = createResponse();
    expect(await handleMuxInboundHttpRequest(req, res)).toBe(true);
    expect(res.statusCode).toBe(202);

    expect(mocks.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const call = mocks.dispatchInboundMessage.mock.calls[0]?.[0] as
      | {
          ctx?: { MessageSid?: string };
          replyOptions?: {
            images?: Array<{ type: string; data: string; mimeType: string }>;
          };
        }
      | undefined;
    expect(call?.ctx?.MessageSid).toBe("mux-img-1");
    expect(call?.replyOptions?.images).toEqual([
      {
        type: "image",
        data: ONE_PIXEL_PNG_BASE64,
        mimeType: "image/png",
      },
    ]);
  });
});
