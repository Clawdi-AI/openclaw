import { readFile, stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIMessageApiService,
  type IMessageSdkInstance,
} from "../src/channels/imessage/api.js";

type SdkCall = {
  chatGuid: string;
  filePath?: string;
  fileName?: string;
  message?: string;
  selectedMessageGuid?: string;
};

function buildFakeSdk() {
  const calls: { sendMessage: SdkCall[]; sendAttachment: SdkCall[] } = {
    sendMessage: [],
    sendAttachment: [],
  };
  // Capture observed file contents keyed by filePath so tests can verify the
  // downloaded buffer was persisted to disk exactly where we handed it off.
  const observed: Record<string, Buffer | null> = {};
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
      sendAttachment: vi.fn(async (opts) => {
        let body: Buffer | null = null;
        try {
          body = await readFile(opts.filePath);
        } catch {
          body = null;
        }
        observed[opts.filePath] = body;
        calls.sendAttachment.push({
          chatGuid: opts.chatGuid,
          filePath: opts.filePath,
          ...(opts.fileName ? { fileName: opts.fileName } : {}),
          ...(opts.selectedMessageGuid ? { selectedMessageGuid: opts.selectedMessageGuid } : {}),
        });
        return { guid: `att-${calls.sendAttachment.length}` };
      }),
      downloadAttachment: vi.fn(async () => Buffer.alloc(0)),
    },
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { sdk, calls, observed };
}

describe("iMessage api sendMessage", () => {
  let log: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    log = vi.fn();
  });

  it("passes selectedMessageGuid when reply threading is requested", async () => {
    const { sdk, calls } = buildFakeSdk();
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log,
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
      log,
      loadSdkFactory: async () => () => sdk,
    });
    service.setSdk(sdk);

    await service.sendMessage({ chatGuid: "iMessage;-;+14155551234", message: "hi" });

    expect(calls.sendMessage).toEqual([{ chatGuid: "iMessage;-;+14155551234", message: "hi" }]);
  });
});

describe("iMessage api sendAttachment", () => {
  let log: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    log = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects non-https URLs before touching the SDK", async () => {
    const { sdk, calls } = buildFakeSdk();
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log,
      loadSdkFactory: async () => () => sdk,
    });
    service.setSdk(sdk);

    await expect(
      service.sendAttachment({
        chatGuid: "iMessage;-;+14155551234",
        attachmentUrl: "http://evil.example/file",
      }),
    ).rejects.toThrow(/must be https/);
    expect(calls.sendAttachment).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ type: "imessage_outbound_media_rejected" }),
    );
  });

  it("downloads url, writes temp file, passes path to SDK, then unlinks", async () => {
    const { sdk, calls, observed } = buildFakeSdk();
    const download = vi.fn(async () => ({
      body: Buffer.from("hello-image-bytes"),
      fileName: "cat.jpg",
    }));
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log,
      loadSdkFactory: async () => () => sdk,
      downloadAttachmentFromUrl: download,
    });
    service.setSdk(sdk);

    const result = await service.sendAttachment({
      chatGuid: "iMessage;-;+14155551234",
      attachmentUrl: "https://cdn.example.com/path/cat.jpg",
      selectedMessageGuid: "reply-msg-42",
    });

    expect(download).toHaveBeenCalledWith("https://cdn.example.com/path/cat.jpg");
    expect(result.guid).toBe("att-1");
    expect(calls.sendAttachment).toHaveLength(1);
    const call = calls.sendAttachment[0];
    expect(call.chatGuid).toBe("iMessage;-;+14155551234");
    expect(call.selectedMessageGuid).toBe("reply-msg-42");
    expect(call.fileName).toBe("cat.jpg");
    // SDK receives a local absolute path, not the source URL.
    expect(call.filePath?.startsWith("/")).toBe(true);
    expect(call.filePath).not.toContain("://");
    // Temp file preserved the extension (so iOS attachment-type detection works).
    expect(call.filePath?.endsWith(".jpg")).toBe(true);
    // The file we handed to the SDK actually contained the downloaded bytes.
    expect(observed[call.filePath!]?.equals(Buffer.from("hello-image-bytes"))).toBe(true);
    // Temp file removed after send completes.
    await expect(stat(call.filePath!)).rejects.toThrow();
  });

  it("unlinks temp file even when the SDK throws", async () => {
    const { sdk } = buildFakeSdk();
    // Capture the real filePath the wrapper passed in, then throw so we
    // can verify the file still existed at the moment of the throw and
    // was unlinked afterward.
    let capturedPath: string | null = null;
    sdk.attachments.sendAttachment = vi.fn(async (opts) => {
      capturedPath = opts.filePath;
      // File must exist at SDK call time (wrapper wrote it before us).
      const bytes = await readFile(opts.filePath);
      expect(bytes.equals(Buffer.from("x"))).toBe(true);
      throw new Error("photon down");
    });
    const download = vi.fn(async () => ({ body: Buffer.from("x"), fileName: "x.png" }));
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log,
      loadSdkFactory: async () => () => sdk,
      downloadAttachmentFromUrl: download,
    });
    service.setSdk(sdk);

    await expect(
      service.sendAttachment({
        chatGuid: "iMessage;-;+14155551234",
        attachmentUrl: "https://cdn.example.com/x.png",
      }),
    ).rejects.toThrow(/attachment send failed/);

    // SDK was actually called (wrapper wrote the file before invoking).
    expect(capturedPath).toBeTruthy();
    // And the temp file was unlinked by the finally block.
    await expect(stat(capturedPath!)).rejects.toThrow();
  });

  it("derives a safe fileName from the URL when the download does not supply one", async () => {
    const { sdk, calls } = buildFakeSdk();
    const download = vi.fn(async () => ({ body: Buffer.from("x") }));
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log,
      loadSdkFactory: async () => () => sdk,
      downloadAttachmentFromUrl: download,
    });
    service.setSdk(sdk);

    await service.sendAttachment({
      chatGuid: "iMessage;-;+14155551234",
      attachmentUrl: "https://cdn.example.com/u/user-42/photo.heic?expires=123",
    });

    expect(calls.sendAttachment[0].fileName).toBe("photo.heic");
    expect(calls.sendAttachment[0].filePath?.endsWith(".heic")).toBe(true);
  });

  it("falls back to attachment.bin when the URL has no basename", async () => {
    const { sdk, calls } = buildFakeSdk();
    const download = vi.fn(async () => ({ body: Buffer.from("x") }));
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log,
      loadSdkFactory: async () => () => sdk,
      downloadAttachmentFromUrl: download,
    });
    service.setSdk(sdk);

    await service.sendAttachment({
      chatGuid: "iMessage;-;+14155551234",
      attachmentUrl: "https://cdn.example.com/",
    });

    expect(calls.sendAttachment[0].fileName).toBe("attachment.bin");
  });

  // Regression: https://picsum.photos/1024 returns JPEG bytes with
  // Content-Type: image/jpeg but the URL path has no extension. Before the
  // Content-Type fallback this shipped to Photon as an extensionless upload,
  // form-data inferred application/octet-stream, and iOS rendered a generic
  // .bin file bubble instead of the inline image preview.
  it("infers .jpg from Content-Type when the URL has no extension", async () => {
    const { sdk, calls } = buildFakeSdk();
    const download = vi.fn(async () => ({
      body: Buffer.from("jpeg-bytes"),
      contentType: "image/jpeg",
    }));
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log,
      loadSdkFactory: async () => () => sdk,
      downloadAttachmentFromUrl: download,
    });
    service.setSdk(sdk);

    await service.sendAttachment({
      chatGuid: "iMessage;-;+14155551234",
      attachmentUrl: "https://picsum.photos/1024",
    });

    const call = calls.sendAttachment[0];
    expect(call.fileName).toBe("1024.jpg");
    expect(call.filePath?.endsWith(".jpg")).toBe(true);
  });

  it("prefers URL extension over Content-Type when both present", async () => {
    const { sdk, calls } = buildFakeSdk();
    const download = vi.fn(async () => ({
      body: Buffer.from("x"),
      contentType: "application/octet-stream",
    }));
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log,
      loadSdkFactory: async () => () => sdk,
      downloadAttachmentFromUrl: download,
    });
    service.setSdk(sdk);

    await service.sendAttachment({
      chatGuid: "iMessage;-;+14155551234",
      attachmentUrl: "https://cdn.example.com/path/video.mov",
    });

    const call = calls.sendAttachment[0];
    expect(call.fileName).toBe("video.mov");
    expect(call.filePath?.endsWith(".mov")).toBe(true);
  });

  // image/pjpeg, video/quicktime, audio/mpeg land in MIME_EXTENSION_OVERRIDE
  // because mime-db would otherwise hand us .jfif / .qt / .mpga — all
  // technically correct but not what iOS or users expect for pictures, movies,
  // and MP3s. The rest flow through mime-types directly.
  it.each([
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["image/gif", ".gif"],
    ["image/heic", ".heic"],
    ["image/jpeg", ".jpg"],
    ["image/pjpeg", ".jpg"], // override: mime-db → .jfif
    ["video/mp4", ".mp4"],
    ["video/quicktime", ".mov"], // override: mime-db → .qt
    ["audio/mp4", ".m4a"],
    ["audio/mpeg", ".mp3"], // override: mime-db → .mpga
    ["application/pdf", ".pdf"],
  ])("maps %s → %s when URL has no extension", async (contentType, expectedExt) => {
    const { sdk, calls } = buildFakeSdk();
    const download = vi.fn(async () => ({ body: Buffer.from("x"), contentType }));
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log,
      loadSdkFactory: async () => () => sdk,
      downloadAttachmentFromUrl: download,
    });
    service.setSdk(sdk);

    await service.sendAttachment({
      chatGuid: "iMessage;-;+14155551234",
      attachmentUrl: "https://cdn.example.com/asset",
    });

    expect(calls.sendAttachment[0].filePath?.endsWith(expectedExt)).toBe(true);
  });

  // Content-Type: image/jpeg; charset=utf-8 — some misconfigured servers
  // include charset on binary types. The lookup must strip the params.
  it("ignores Content-Type parameters like ;charset=...", async () => {
    const { sdk, calls } = buildFakeSdk();
    const download = vi.fn(async () => ({
      body: Buffer.from("x"),
      contentType: "image/jpeg; charset=utf-8",
    }));
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log,
      loadSdkFactory: async () => () => sdk,
      downloadAttachmentFromUrl: download,
    });
    service.setSdk(sdk);

    await service.sendAttachment({
      chatGuid: "iMessage;-;+14155551234",
      attachmentUrl: "https://cdn.example.com/asset",
    });

    expect(calls.sendAttachment[0].filePath?.endsWith(".jpg")).toBe(true);
  });

  // picsum.photos/1024 issues a 302 to fastly.picsum.photos/<id>/1024/1024.jpg.
  // The redirect target carries the real extension, and the original URL has
  // none — so `finalUrl` must take priority over the requested URL when we
  // derive the basename.
  it("prefers final URL basename over original URL after a redirect", async () => {
    const { sdk, calls } = buildFakeSdk();
    const download = vi.fn(async () => ({
      body: Buffer.from("x"),
      contentType: "image/jpeg",
      finalUrl: "https://fastly.picsum.photos/id/986/1024/1024.jpg?hmac=abc",
    }));
    const service = createIMessageApiService({
      serverUrl: "https://photon.local",
      apiKey: "k",
      log,
      loadSdkFactory: async () => () => sdk,
      downloadAttachmentFromUrl: download,
    });
    service.setSdk(sdk);

    await service.sendAttachment({
      chatGuid: "iMessage;-;+14155551234",
      attachmentUrl: "https://picsum.photos/1024",
    });

    const call = calls.sendAttachment[0];
    expect(call.fileName).toBe("1024.jpg");
    expect(call.filePath?.endsWith(".jpg")).toBe(true);
  });
});
