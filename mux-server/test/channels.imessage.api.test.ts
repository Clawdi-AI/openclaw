import { describe, expect, it, vi } from "vitest";
import {
  createIMessageApiService,
  type IMessageSdkInstance,
} from "../src/channels/imessage/api.js";

// ── SDK fake (for sendMessage path only) ─────────────────────────────
type SendMessageCall = { chatGuid: string; message: string; selectedMessageGuid?: string };

function buildFakeSdk() {
  const calls: { sendMessage: SendMessageCall[] } = { sendMessage: [] };
  const sdk: IMessageSdkInstance = {
    messages: {
      sendMessage: vi.fn(async (opts) => {
        calls.sendMessage.push({
          chatGuid: opts.chatGuid,
          message: opts.message,
          ...(opts.selectedMessageGuid ? { selectedMessageGuid: opts.selectedMessageGuid } : {}),
        });
        return { guid: `msg-${calls.sendMessage.length}` };
      }),
    },
    attachments: {
      // Our sendAttachment no longer touches the SDK's attachment module;
      // keep a stub so the type-check passes but fail loudly if something
      // accidentally goes through here.
      sendAttachment: vi.fn(async () => {
        throw new Error("SDK sendAttachment should not be called — wrapper posts directly");
      }),
      downloadAttachment: vi.fn(async () => Buffer.alloc(0)),
    },
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { sdk, calls };
}

// ── Multipart upload inspector ───────────────────────────────────────
// Captures what the wrapper sends to Photon's POST /api/v1/message/attachment
// and exposes it as structured fields so tests can assert on the exact bytes
// + Content-Type that iOS will ultimately see.
type CapturedUpload = {
  url: string;
  headers: Record<string, string>;
  fields: Record<string, string>;
  attachment?: {
    filename: string;
    contentType: string;
    body: Buffer;
  };
};

async function parseMultipartForm(form: FormData): Promise<{
  fields: Record<string, string>;
  attachment?: CapturedUpload["attachment"];
}> {
  const fields: Record<string, string> = {};
  let attachment: CapturedUpload["attachment"] | undefined;
  // biome-ignore lint/style/noNonNullAssertion: iterating FormData entries
  for (const [key, value] of form.entries()) {
    if (value instanceof Blob) {
      // `value` is a Blob — when appended via `form.append(key, blob, filename)`
      // the filename arrives on the File subclass; native FormData constructs a
      // File wrapper preserving both `name` and `type`.
      const file = value as File;
      attachment = {
        filename: file.name,
        contentType: file.type,
        body: Buffer.from(await file.arrayBuffer()),
      };
    } else {
      fields[key] = String(value);
    }
  }
  return { fields, attachment };
}

function captureUploader(responseBody: unknown, status = 200) {
  const captured: CapturedUpload[] = [];
  const uploader = vi.fn(
    async ({
      url,
      headers,
      body,
    }: {
      url: string;
      headers: Record<string, string>;
      body: FormData;
    }) => {
      const parsed = await parseMultipartForm(body);
      captured.push({ url, headers, fields: parsed.fields, attachment: parsed.attachment });
      return new Response(
        typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
        { status, headers: { "content-type": "application/json" } },
      );
    },
  );
  return { captured, uploader };
}

// ── sendMessage — unchanged, still via SDK ───────────────────────────

describe("iMessage api sendMessage", () => {
  it("passes selectedMessageGuid when reply threading is requested", async () => {
    const { sdk, calls } = buildFakeSdk();
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log: vi.fn(),
      loadSdkFactory: async () => () => sdk,
    });
    service.setSdk(sdk);

    const result = await service.sendMessage({
      chatGuid: "iMessage;-;+14155551234",
      message: "replying",
      selectedMessageGuid: "reply-target-1",
    });

    expect(result.guid).toBe("msg-1");
    expect(calls.sendMessage).toEqual([
      {
        chatGuid: "iMessage;-;+14155551234",
        message: "replying",
        selectedMessageGuid: "reply-target-1",
      },
    ]);
  });

  it("omits selectedMessageGuid when not supplied", async () => {
    const { sdk, calls } = buildFakeSdk();
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log: vi.fn(),
      loadSdkFactory: async () => () => sdk,
    });
    service.setSdk(sdk);

    await service.sendMessage({ chatGuid: "iMessage;-;+14155551234", message: "hi" });

    expect(calls.sendMessage).toEqual([{ chatGuid: "iMessage;-;+14155551234", message: "hi" }]);
  });
});

// ── sendAttachment — direct-POST path ────────────────────────────────

describe("iMessage api sendAttachment (direct POST)", () => {
  const chatGuid = "iMessage;-;+14155551234";

  function setup(opts: {
    download: () => Promise<{
      body: Buffer;
      fileName?: string;
      contentType?: string;
      finalUrl?: string;
    }>;
    responseBody?: unknown;
    status?: number;
  }) {
    const { sdk } = buildFakeSdk();
    const { captured, uploader } = captureUploader(
      opts.responseBody ?? { data: { guid: "att-xyz" } },
      opts.status ?? 200,
    );
    const log = vi.fn();
    const service = createIMessageApiService({
      serverUrl: "https://photon.local/",
      apiKey: "my-key",
      log,
      loadSdkFactory: async () => () => sdk,
      downloadAttachmentFromUrl: vi.fn(opts.download),
      uploadAttachmentRequest: uploader,
    });
    service.setSdk(sdk);
    return { service, captured, log, uploader };
  }

  it("rejects non-https URLs before anything else fires", async () => {
    const { service, captured } = setup({
      download: async () => ({ body: Buffer.from("x"), contentType: "image/jpeg" }),
    });
    await expect(
      service.sendAttachment({ chatGuid, attachmentUrl: "http://evil.example/x" }),
    ).rejects.toThrow(/must be https/);
    expect(captured).toHaveLength(0);
  });

  it("POSTs the downloaded bytes and uses redirect-target basename", async () => {
    const { service, captured } = setup({
      download: async () => ({
        body: Buffer.from("jpeg-bytes"),
        contentType: "image/jpeg",
        finalUrl: "https://fastly.picsum.photos/id/42/1024/1024.jpg?hmac=abc",
      }),
    });

    const result = await service.sendAttachment({
      chatGuid,
      attachmentUrl: "https://picsum.photos/1024",
      selectedMessageGuid: "reply-target",
    });

    expect(result.guid).toBe("att-xyz");
    expect(captured).toHaveLength(1);
    const upload = captured[0];

    expect(upload.url).toBe("https://photon.local/api/v1/message/attachment");
    expect(upload.headers["X-API-Key"]).toBe("my-key");
    expect(upload.fields.chatGuid).toBe(chatGuid);
    // Redirect target had .jpg → use it directly, no Content-Type synthesis needed.
    expect(upload.fields.name).toBe("1024.jpg");
    expect(upload.attachment?.filename).toBe("1024.jpg");
    expect(upload.fields.selectedMessageGuid).toBe("reply-target");
    expect(upload.fields.tempGuid).toMatch(/^[0-9a-f-]{36}$/i);
    expect(upload.attachment?.body.equals(Buffer.from("jpeg-bytes"))).toBe(true);
  });

  // Empirically confirmed against live Photon server: UTI/MIME is decided by
  // the filename extension only; the part's Content-Type header is ignored.
  //   filename=1024 + blob=image/jpeg → uti=null (file bubble)
  //   filename=1024.jpg + blob=octet-stream → uti=public.jpeg (image preview)
  // So when the URL/content-disposition gives no extension we MUST synthesize
  // one from the source Content-Type.
  it("appends extension from Content-Type when URL has none (picsum regression)", async () => {
    const { service, captured } = setup({
      download: async () => ({
        body: Buffer.from("x"),
        contentType: "image/jpeg",
      }),
    });
    await service.sendAttachment({
      chatGuid,
      attachmentUrl: "https://picsum.photos/1024",
    });
    expect(captured[0].fields.name).toBe("1024.jpg");
    expect(captured[0].attachment?.filename).toBe("1024.jpg");
  });

  it("strips Content-Type parameters like ;charset=utf-8 when synthesising extension", async () => {
    const { service, captured } = setup({
      download: async () => ({
        body: Buffer.from("x"),
        contentType: "image/jpeg; charset=utf-8",
      }),
    });
    await service.sendAttachment({
      chatGuid,
      attachmentUrl: "https://cdn.example.com/asset",
    });
    expect(captured[0].fields.name).toBe("asset.jpg");
  });

  it("falls back to .bin when neither URL nor Content-Type give a clue", async () => {
    const { service, captured } = setup({
      download: async () => ({ body: Buffer.from("x") }),
    });
    await service.sendAttachment({
      chatGuid,
      attachmentUrl: "https://cdn.example.com/blob",
    });
    expect(captured[0].fields.name).toBe("blob.bin");
  });

  it("leaves filename untouched when it already has an extension", async () => {
    const { service, captured } = setup({
      download: async () => ({
        body: Buffer.from("x"),
        contentType: "image/png",
        fileName: "sunset.png",
        finalUrl: "https://cdn.example.com/image/id/42",
      }),
    });
    await service.sendAttachment({
      chatGuid,
      attachmentUrl: "https://cdn.example.com/image/id/42",
    });
    expect(captured[0].fields.name).toBe("sunset.png");
    expect(captured[0].attachment?.filename).toBe("sunset.png");
  });

  // Overrides where mime-db's canonical extension is worse than the
  // user-facing one iOS expects.
  it.each([
    ["image/pjpeg", ".jpg"],
    ["video/quicktime", ".mov"],
    ["audio/mpeg", ".mp3"],
  ])("overrides mime-db for %s → %s", async (contentType, expectedExt) => {
    const { service, captured } = setup({
      download: async () => ({ body: Buffer.from("x"), contentType }),
    });
    await service.sendAttachment({
      chatGuid,
      attachmentUrl: "https://cdn.example.com/asset",
    });
    expect(captured[0].fields.name.endsWith(expectedExt)).toBe(true);
  });

  it("retries with chat/new when Photon reports the chat does not exist", async () => {
    let call = 0;
    const chatNewCalls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      // URL objects stringify to "[object Object]" without href; normalize first.
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      chatNewCalls.push({ url: urlStr, body: init?.body });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof fetch;

    try {
      const { sdk } = buildFakeSdk();
      const uploader = vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return new Response(JSON.stringify({ error: { message: "chat does not exist" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ data: { guid: "retry-ok" } }), { status: 200 });
      });
      const service = createIMessageApiService({
        serverUrl: "https://photon.local",
        apiKey: "k",
        log: vi.fn(),
        loadSdkFactory: async () => () => sdk,
        downloadAttachmentFromUrl: async () => ({
          body: Buffer.from("x"),
          contentType: "image/jpeg",
        }),
        uploadAttachmentRequest: uploader,
      });
      service.setSdk(sdk);

      const result = await service.sendAttachment({
        chatGuid: "iMessage;-;+15551234567",
        attachmentUrl: "https://cdn.example.com/x.jpg",
      });

      expect(result.guid).toBe("retry-ok");
      expect(uploader).toHaveBeenCalledTimes(2);
      expect(chatNewCalls).toHaveLength(1);
      expect(chatNewCalls[0]).toMatchObject({
        url: "https://photon.local/api/v1/chat/new",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces upstream 4xx as IMessagePhotonError with httpStatus", async () => {
    const { service } = setup({
      responseBody: { error: { message: "Unauthorized" } },
      status: 401,
      download: async () => ({ body: Buffer.from("x"), contentType: "image/jpeg" }),
    });
    await expect(
      service.sendAttachment({ chatGuid, attachmentUrl: "https://cdn.example.com/x.jpg" }),
    ).rejects.toMatchObject({ httpStatus: 401, stage: "attachment" });
  });
});
