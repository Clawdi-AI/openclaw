// iMessage API service wrapping the Photon Advanced iMessage Kit SDK.
// SDK types are declared manually because the package does not ship typings.

import { randomUUID } from "node:crypto";
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
  // enqueueSend is the SDK's send-queue primitive (dist/index.js:1023-1027).
  // SDK methods (sendMessage, sendAttachment, sendSticker, etc.) all run
  // through this single per-instance serial queue — so a reply "here's your
  // image:" followed by the image itself always lands at Photon in the same
  // order the caller issued them. Our direct-POST path for attachments MUST
  // share this queue, otherwise native sendMessage and our attachment send
  // race.
  enqueueSend: <T>(task: () => Promise<T>) => Promise<T>;
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
    "enqueueSend" in value &&
    typeof (value as { enqueueSend?: unknown }).enqueueSend === "function" &&
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

// Override for tests: stub the POST /api/v1/message/attachment upload.
type AttachmentUploader = (args: {
  url: string;
  headers: Record<string, string>;
  body: FormData;
}) => Promise<Response>;

// mime-db canonical extensions that are technically correct but user-hostile
// or iOS-unfriendly. Keep this intentionally tiny — every override is a
// deliberate deviation from the db that form-data / mime-db would otherwise
// pick automatically, backed by a specific reason.
//
//   image/pjpeg     → mime-db gives .jfif  (we want .jpg for iOS)
//   video/quicktime → mime-db gives .qt    (we want .mov for iOS)
//   audio/mpeg      → mime-db gives .mpga  (we want .mp3 for iOS)
const MIME_EXTENSION_OVERRIDE: Readonly<Record<string, string>> = {
  "image/pjpeg": ".jpg",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
};

function extensionForContentType(contentType: string | null | undefined): string | null {
  if (!contentType) {
    return null;
  }
  // Strip `; charset=...` parameters before lookup.
  const base = contentType.split(";")[0]?.trim().toLowerCase();
  if (!base) {
    return null;
  }
  if (MIME_EXTENSION_OVERRIDE[base]) {
    return MIME_EXTENSION_OVERRIDE[base];
  }
  const ext = mimeTypes.extension(base);
  return ext ? `.${ext}` : null;
}

// Parse `{service};-;{address}` like `iMessage;-;+14155551234` or
// `any;-;+14155551234`. Mirrors the SDK's internal extractAddress /
// extractService so our chat-not-exist retry matches SDK behaviour.
function parseChatGuid(chatGuid: string): { address: string; service?: string } | null {
  const parts = chatGuid.split(";-;");
  if (parts.length !== 2 || !parts[1]) {
    return null;
  }
  const address = parts[1];
  const prefix = chatGuid.split(";")[0]?.toLowerCase() ?? "";
  let service: string | undefined;
  if (prefix === "imessage") {
    service = "iMessage";
  } else if (prefix === "sms") {
    service = "SMS";
  }
  return { address, service };
}

function isChatNotExistResponse(body: string): boolean {
  try {
    const parsed = JSON.parse(body);
    const message = (parsed?.error?.message || parsed?.message || "").toString().toLowerCase();
    return message.includes("chat does not exist") || message.includes("chat not found");
  } catch {
    return false;
  }
}

export function createIMessageApiService(deps: {
  serverUrl: string;
  apiKey: string | null;
  log: (entry: Record<string, unknown>) => void;
  loadSdkFactory: () => Promise<
    (opts: { serverUrl: string; apiKey?: string; logLevel?: string }) => unknown
  >;
  // Tests override; production falls back to global fetch.
  downloadAttachmentFromUrl?: AttachmentDownloader;
  uploadAttachmentRequest?: AttachmentUploader;
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

  // Posts directly to Photon's /api/v1/message/attachment instead of going
  // through the SDK's attachments.sendAttachment method.
  //
  // Why bypass the SDK:
  //   The SDK helper does `readFile(options.filePath)` then
  //   `form.append("attachment", buf, fileName)` — forcing callers to land
  //   bytes on disk first, and crashing on https:// URLs. Bypassing lets us
  //   stream the downloaded buffer straight into multipart with zero
  //   tempfile race surface, own error handling (preserve upstream 4xx/5xx
  //   status through IMessagePhotonError), and match the contract Photon
  //   actually expects.
  //
  // Why the filename still carries an extension:
  //   Photon's server decides UTI/MIME *purely* from the filename extension
  //   (empirically A/B-tested: filename="1024" + blob type="image/jpeg" →
  //   uti=null / file bubble on iOS; filename="1024.jpg" + blob type="octet-
  //   stream" → uti=public.jpeg / inline image). Blob.type on the multipart
  //   part is ignored by Photon. We still pass it through for correctness on
  //   any RFC-compliant recipient, but extension synthesis is load-bearing.
  //
  // Why enqueueSend wraps the send:
  //   SDK sendMessage / sendAttachment / sendSticker all run through a
  //   single per-instance serial queue (dist/index.js:1023-1027) so that
  //   ordered sends ("here's your image:" then the image) land at Photon in
  //   caller order. Direct-POSTing without enqueueSend would race with SDK
  //   text sends and deliver images before their captions.
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

    if (download.body.length === 0) {
      deps.log({
        type: "imessage_outbound_media_rejected",
        chatGuid: params.chatGuid,
        url: params.attachmentUrl,
        reason: "empty body",
      });
      throw new Error("iMessage attachment download returned zero bytes");
    }

    // Prefer the FINAL URL (post-redirect) basename — picsum /1024
    // redirects to fastly.picsum.photos/.../1024.jpg, which carries the
    // extension the source URL lacked.
    const urlBaseName = safeBaseNameFromUrl(download.finalUrl ?? params.attachmentUrl);
    const rawName = download.fileName ?? urlBaseName ?? "attachment";
    const contentType = download.contentType?.split(";")[0]?.trim() || "application/octet-stream";

    const nameExt = path.extname(rawName);
    const resolvedExt = nameExt || extensionForContentType(download.contentType) || ".bin";
    const fileName = nameExt ? rawName : `${rawName}${resolvedExt}`;
    const tempGuid = randomUUID();

    const postUpload = async (): Promise<Response> => {
      const form = new FormData();
      form.append("chatGuid", params.chatGuid);
      // Node's Buffer.buffer is strictly ArrayBuffer (never a
      // SharedArrayBuffer), but TS's widened types can't prove that to the
      // Blob constructor. Copy the bytes into a plain ArrayBuffer so the
      // Blob constructor accepts the part without a cast. The copy is
      // unavoidable for strict typing but stays single-pass.
      const bodyBuffer = new ArrayBuffer(download.body.byteLength);
      new Uint8Array(bodyBuffer).set(download.body);
      form.append("attachment", new Blob([bodyBuffer], { type: contentType }), fileName);
      form.append("name", fileName);
      form.append("tempGuid", tempGuid);
      if (params.selectedMessageGuid) {
        form.append("selectedMessageGuid", params.selectedMessageGuid);
      }
      const headers: Record<string, string> = {};
      if (deps.apiKey) {
        headers["X-API-Key"] = deps.apiKey;
      }
      const url = `${deps.serverUrl.replace(/\/+$/, "")}/api/v1/message/attachment`;
      const request =
        deps.uploadAttachmentRequest ??
        (async ({ url, headers, body }) => fetch(url, { method: "POST", headers, body }));
      return await request({ url, headers, body: form });
    };

    // Wrap the entire send in the SDK's serial queue so ordered sends from
    // the same instance stay in caller order — matches SDK semantics.
    return await current.enqueueSend(async () => {
      let response = await postUpload();
      let responseText = await response.text();

      // Mirror SDK's chat-not-exist retry: if Photon rejects the upload
      // because there's no existing conversation for this address, create
      // the chat via POST /api/v1/chat/new and retry once.
      if (!response.ok && isChatNotExistResponse(responseText)) {
        const parsed = parseChatGuid(params.chatGuid);
        if (parsed?.address) {
          try {
            await createChat({ address: parsed.address, service: parsed.service });
          } catch (error) {
            deps.log({
              type: "imessage_send_attachment_error",
              chatGuid: params.chatGuid,
              phase: "chat_new_failed",
              error: String(error),
            });
            throw new IMessagePhotonError("iMessage attachment send failed", {
              httpStatus: null,
              stage: "attachment",
              cause: error,
            });
          }
          response = await postUpload();
          responseText = await response.text();
        }
      }

      if (!response.ok) {
        deps.log({
          type: "imessage_send_attachment_error",
          chatGuid: params.chatGuid,
          httpStatus: response.status,
          body: responseText.slice(0, 300),
        });
        throw new IMessagePhotonError("iMessage attachment send failed", {
          httpStatus: response.status,
          stage: "attachment",
          cause: responseText.slice(0, 300),
        });
      }

      // Fail closed on protocol corruption. The SDK unconditionally returns
      // response.data.data (dist/index.js:235-238); an empty body, invalid
      // JSON, or data: null would all have thrown on a naive property read
      // and we don't want to silently succeed with guid=null instead.
      let parsed: unknown;
      try {
        parsed = responseText ? JSON.parse(responseText) : null;
      } catch (error) {
        deps.log({
          type: "imessage_send_attachment_error",
          chatGuid: params.chatGuid,
          phase: "invalid_json",
          body: responseText.slice(0, 200),
        });
        throw new IMessagePhotonError("iMessage attachment send failed", {
          httpStatus: response.status,
          stage: "attachment",
          cause: error,
        });
      }
      const data = (parsed as { data?: unknown } | null)?.data;
      if (!data || typeof data !== "object") {
        deps.log({
          type: "imessage_send_attachment_error",
          chatGuid: params.chatGuid,
          phase: "missing_data",
          body: responseText.slice(0, 200),
        });
        throw new IMessagePhotonError("iMessage attachment send failed", {
          httpStatus: response.status,
          stage: "attachment",
          cause: "response missing data",
        });
      }
      const guid = (data as { guid?: unknown }).guid;
      return { guid: typeof guid === "string" ? guid : null };
    });
  }

  async function createChat(params: { address: string; service?: string }): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (deps.apiKey) {
      headers["X-API-Key"] = deps.apiKey;
    }
    const url = `${deps.serverUrl.replace(/\/+$/, "")}/api/v1/chat/new`;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        addresses: [params.address],
        ...(params.service ? { service: params.service } : {}),
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`iMessage chat/new failed: ${response.status} ${body.slice(0, 200)}`);
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
