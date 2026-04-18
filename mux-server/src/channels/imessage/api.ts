// iMessage API service wrapping the Photon Advanced iMessage Kit SDK.
// SDK types are declared manually because the package does not ship typings.

import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import mimeTypes from "mime-types";

export type IMessageSdkInstance = {
  messages: {
    sendMessage: (opts: {
      chatGuid: string;
      message: string;
      selectedMessageGuid?: string;
    }) => Promise<{ guid?: string }>;
  };
  attachments: {
    sendAttachment: (opts: {
      chatGuid: string;
      filePath: string;
      fileName?: string;
      selectedMessageGuid?: string;
    }) => Promise<{ guid?: string }>;
    downloadAttachment: (guid: string) => Promise<Buffer>;
  };
  connect: () => Promise<void>;
  close: () => Promise<void>;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  off: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type IMessageHealth = {
  connected: boolean;
  loopStartedAtMs: number | null;
  lastSdkConnectedAtMs: number | null;
  lastSdkClosedAtMs: number | null;
  lastSdkErrorAtMs: number | null;
  lastSdkError: string | null;
  lastInboundSeenAtMs: number | null;
};

// Photon REST caps single attachments at ~100 MB. Keep a hard ceiling so a
// malicious openclaw cannot drain mux-server disk / memory on a poisoned URL.
const IMESSAGE_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
const IMESSAGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;

// Thrown when the underlying Photon SDK call returned an HTTP error. We
// preserve the status so the outbound service can differentiate permanent
// client errors (4xx — do NOT retry) from transient server errors (5xx — safe
// to retry). Otherwise every Photon rejection looks like a retryable 502 to
// openclaw, which leads to duplicated sends on permanent 4xx cases.
export class IMessagePhotonError extends Error {
  readonly httpStatus: number | null;
  readonly stage: "send" | "attachment";
  constructor(
    message: string,
    opts: { httpStatus: number | null; stage: "send" | "attachment"; cause?: unknown },
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = "IMessagePhotonError";
    this.httpStatus = opts.httpStatus;
    this.stage = opts.stage;
  }
}

function extractHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  // Axios error shape (the Photon SDK uses axios internally).
  const response = (error as { response?: { status?: unknown } }).response;
  if (response && typeof response.status === "number" && Number.isFinite(response.status)) {
    return response.status;
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) {
    return status;
  }
  return null;
}

export function isIMessageSdkInstance(value: unknown): value is IMessageSdkInstance {
  return (
    typeof value === "object" &&
    value !== null &&
    "connect" in value &&
    "close" in value &&
    "messages" in value &&
    "attachments" in value &&
    "on" in value &&
    "off" in value
  );
}

// Override for tests: inject a pre-built buffer instead of hitting the network.
type AttachmentDownloader = (url: string) => Promise<{
  body: Buffer;
  fileName?: string;
  contentType?: string;
  finalUrl?: string;
}>;

// Overrides where `mime-types` (via mime-db) would pick a canonical extension
// that isn't what iOS / the user expects. Every entry here is strictly more
// readable than the mime-db default; leave out types where mime-db is already
// right so the two sources of truth can't silently drift.
//
//   image/pjpeg       mime-db → jfif       (we want .jpg)
//   video/quicktime   mime-db → qt         (we want .mov)
//   audio/mpeg        mime-db → mpga       (we want .mp3)
const MIME_EXTENSION_OVERRIDE: Readonly<Record<string, string>> = {
  "image/pjpeg": ".jpg",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
};

function extensionForContentType(contentType: string | null | undefined): string | null {
  if (!contentType) {
    return null;
  }
  // Strip `; charset=...` etc before lookup.
  const base = contentType.split(";")[0]?.trim().toLowerCase();
  if (!base) {
    return null;
  }
  const override = MIME_EXTENSION_OVERRIDE[base];
  if (override) {
    return override;
  }
  // mime-types shares mime-db with form-data's inference, so whatever
  // extension it returns here will round-trip to the same MIME when
  // form-data's upload path re-infers from the filename.
  const ext = mimeTypes.extension(base);
  return ext ? `.${ext}` : null;
}

export function createIMessageApiService(deps: {
  serverUrl: string;
  apiKey: string | null;
  log: (entry: Record<string, unknown>) => void;
  loadSdkFactory: () => Promise<
    (opts: { serverUrl: string; apiKey?: string; logLevel?: string }) => unknown
  >;
  // Tests override this; production falls back to global fetch.
  downloadAttachmentFromUrl?: AttachmentDownloader;
}) {
  const health: IMessageHealth = {
    connected: false,
    loopStartedAtMs: null,
    lastSdkConnectedAtMs: null,
    lastSdkClosedAtMs: null,
    lastSdkErrorAtMs: null,
    lastSdkError: null,
    lastInboundSeenAtMs: null,
  };

  let sdk: IMessageSdkInstance | null = null;

  function getSdk(): IMessageSdkInstance | null {
    return sdk;
  }

  function setSdk(next: IMessageSdkInstance | null): void {
    sdk = next;
  }

  function getHealth(): IMessageHealth {
    return health;
  }

  function markConnected(): void {
    health.connected = true;
    health.lastSdkConnectedAtMs = Date.now();
    health.lastSdkError = null;
    health.lastSdkErrorAtMs = null;
  }

  function markDisconnected(): void {
    health.connected = false;
    health.lastSdkClosedAtMs = Date.now();
  }

  function markError(error: unknown): void {
    health.connected = false;
    health.lastSdkError = String(error);
    health.lastSdkErrorAtMs = Date.now();
  }

  function markInboundSeen(): void {
    health.lastInboundSeenAtMs = Date.now();
  }

  async function createSdk(): Promise<IMessageSdkInstance> {
    const factory = await deps.loadSdkFactory();
    const sdkCandidate = factory({
      serverUrl: deps.serverUrl,
      ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
      logLevel: "info",
    });
    if (!isIMessageSdkInstance(sdkCandidate)) {
      throw new Error("Photon iMessage SDK returned unexpected shape");
    }
    return sdkCandidate;
  }

  async function sendMessage(params: {
    chatGuid: string;
    message: string;
    selectedMessageGuid?: string;
  }): Promise<{ guid: string | null }> {
    const current = sdk;
    if (!current) {
      throw new Error("iMessage SDK not connected");
    }
    try {
      const result = await current.messages.sendMessage({
        chatGuid: params.chatGuid,
        message: params.message,
        ...(params.selectedMessageGuid ? { selectedMessageGuid: params.selectedMessageGuid } : {}),
      });
      return { guid: typeof result?.guid === "string" ? result.guid : null };
    } catch (error) {
      const httpStatus = extractHttpStatus(error);
      deps.log({
        type: "imessage_send_message_error",
        chatGuid: params.chatGuid,
        error: String(error),
        ...(httpStatus !== null ? { httpStatus } : {}),
      });
      throw new IMessagePhotonError("iMessage send failed", {
        httpStatus,
        stage: "send",
        cause: error,
      });
    }
  }

  // Photon SDK's sendAttachment internally does `fs/promises.readFile(filePath)`
  // (see @photon-ai/advanced-imessage-kit@1.14.3 dist/index.js:213). Passing an
  // https:// URL therefore crashes with ENOENT. We download the URL to a temp
  // file, hand that path to the SDK, and unlink on the way out.
  async function sendAttachment(params: {
    chatGuid: string;
    attachmentUrl: string;
    selectedMessageGuid?: string;
  }): Promise<{ guid: string | null }> {
    const current = sdk;
    if (!current) {
      throw new Error("iMessage SDK not connected");
    }
    if (!params.attachmentUrl.toLowerCase().startsWith("https://")) {
      deps.log({
        type: "imessage_outbound_media_rejected",
        chatGuid: params.chatGuid,
        url: params.attachmentUrl,
        reason: "not https",
      });
      throw new Error("iMessage attachment URL must be https://");
    }

    let download: {
      body: Buffer;
      fileName?: string;
      contentType?: string;
      finalUrl?: string;
    };
    try {
      download = await (deps.downloadAttachmentFromUrl ?? defaultDownloadAttachment)(
        params.attachmentUrl,
      );
    } catch (error) {
      deps.log({
        type: "imessage_outbound_media_download_failed",
        chatGuid: params.chatGuid,
        url: params.attachmentUrl,
        error: String(error),
      });
      throw error instanceof Error
        ? error
        : new Error("iMessage attachment download failed", { cause: error });
    }

    // Prefer the FINAL URL (post-redirect) over the original one. picsum
    // does `/1024 → fastly.picsum.photos/id/.../1024.jpg?hmac=...` — the
    // redirect target carries the real extension, the source URL does not.
    const urlBaseName = safeBaseNameFromUrl(download.finalUrl ?? params.attachmentUrl);
    const rawName = download.fileName ?? urlBaseName ?? "attachment";
    const rawExt = path.extname(rawName);
    // If the URL / content-disposition already gave an extension, keep it.
    // Otherwise infer from Content-Type. iMessage can't render attachments
    // with an unknown MIME — iOS silently drops them into a generic file
    // bubble, no preview, no inline playback — so we fall back to ".bin"
    // only as a last resort (matches the rest of the codebase's convention
    // of treating extensionless blobs as octet-stream).
    const resolvedExt = rawExt || extensionForContentType(download.contentType) || ".bin";
    const baseWithoutExt = rawExt ? rawName.slice(0, -rawExt.length) : rawName;
    const fileName = `${baseWithoutExt}${resolvedExt}`;
    const tempPath = path.join(tmpdir(), `imessage-${randomUUID()}${resolvedExt}`);

    try {
      await writeFile(tempPath, download.body);
      try {
        const result = await current.attachments.sendAttachment({
          chatGuid: params.chatGuid,
          filePath: tempPath,
          fileName,
          ...(params.selectedMessageGuid
            ? { selectedMessageGuid: params.selectedMessageGuid }
            : {}),
        });
        return { guid: typeof result?.guid === "string" ? result.guid : null };
      } catch (error) {
        const httpStatus = extractHttpStatus(error);
        deps.log({
          type: "imessage_send_attachment_error",
          chatGuid: params.chatGuid,
          error: String(error),
          ...(httpStatus !== null ? { httpStatus } : {}),
        });
        throw new IMessagePhotonError("iMessage attachment send failed", {
          httpStatus,
          stage: "attachment",
          cause: error,
        });
      }
    } finally {
      try {
        await unlink(tempPath);
      } catch {
        // Best-effort cleanup; missing file is fine (write never landed).
      }
    }
  }

  async function downloadAttachment(guid: string): Promise<Buffer | null> {
    const current = sdk;
    if (!current) {
      return null;
    }
    return downloadAttachmentWith(current, guid);
  }

  // Download attachment using a caller-provided SDK reference. Prefer this in
  // inbound handlers that captured the SDK BEFORE any await so that a concurrent
  // reconnect (setSdk(null)) does not silently drop attachment content mid-flight.
  async function downloadAttachmentWith(
    activeSdk: IMessageSdkInstance,
    guid: string,
  ): Promise<Buffer | null> {
    try {
      const buffer = await activeSdk.attachments.downloadAttachment(guid);
      return Buffer.isBuffer(buffer) ? buffer : null;
    } catch (error) {
      deps.log({ type: "imessage_attachment_download_error", guid, error: String(error) });
      return null;
    }
  }

  // Send the pairing notice through the current SDK. Throws on failure so the
  // caller can log full context (tenantId, chatGuid, phase). Mirrors
  // sendWhatsAppPairingNotice / discord notice semantics.
  async function sendPairingNotice(params: { chatGuid: string; text: string }): Promise<void> {
    try {
      await sendMessage({ chatGuid: params.chatGuid, message: params.text });
    } catch (error) {
      deps.log({
        type: "imessage_pairing_notice_failed",
        chatGuid: params.chatGuid,
        error: String(error),
      });
      throw error instanceof Error
        ? error
        : new Error("iMessage pairing notice failed", { cause: error });
    }
  }

  return {
    getSdk,
    setSdk,
    createSdk,
    getHealth,
    markConnected,
    markDisconnected,
    markError,
    markInboundSeen,
    sendMessage,
    sendAttachment,
    downloadAttachment,
    downloadAttachmentWith,
    sendPairingNotice,
  };
}

async function defaultDownloadAttachment(url: string): Promise<{
  body: Buffer;
  fileName?: string;
  contentType?: string;
  finalUrl?: string;
}> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(IMESSAGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`iMessage attachment fetch failed: ${response.status} ${response.statusText}`);
  }
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > IMESSAGE_ATTACHMENT_MAX_BYTES) {
      throw new Error(
        `iMessage attachment exceeds ${IMESSAGE_ATTACHMENT_MAX_BYTES} bytes (content-length=${contentLength})`,
      );
    }
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > IMESSAGE_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `iMessage attachment exceeds ${IMESSAGE_ATTACHMENT_MAX_BYTES} bytes (downloaded=${arrayBuffer.byteLength})`,
    );
  }
  const disposition = response.headers.get("content-disposition");
  const fileName = parseContentDispositionFileName(disposition) ?? undefined;
  const contentType = response.headers.get("content-type") ?? undefined;
  return {
    body: Buffer.from(arrayBuffer),
    fileName,
    contentType,
    finalUrl: response.url,
  };
}

function parseContentDispositionFileName(header: string | null | undefined): string | null {
  if (!header) {
    return null;
  }
  const filenameStar = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (filenameStar) {
    try {
      return decodeURIComponent(filenameStar[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through
    }
  }
  const filename = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(header);
  if (filename) {
    return (filename[1] ?? filename[2] ?? "").trim();
  }
  return null;
}

function safeBaseNameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    return base && base !== "/" ? base : null;
  } catch {
    return null;
  }
}
