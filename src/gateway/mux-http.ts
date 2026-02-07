import type { IncomingMessage, ServerResponse } from "node:http";
import type { MsgContext } from "../auto-reply/templating.js";
import type { ChatImageContent } from "./chat-attachments.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { loadConfig } from "../config/config.js";
import { parseMessageWithAttachments } from "./chat-attachments.js";
import { readJsonBody } from "./hooks.js";

const DEFAULT_MUX_MAX_BODY_BYTES = 10 * 1024 * 1024;

type MuxInboundAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: unknown;
};

type MuxInboundPayload = {
  eventId?: string;
  channel?: string;
  sessionKey?: string;
  body?: string;
  from?: string;
  to?: string;
  accountId?: string;
  chatType?: string;
  messageId?: string;
  timestampMs?: number;
  threadId?: string | number;
  channelData?: Record<string, unknown>;
  attachments?: MuxInboundAttachment[];
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function resolveBearerToken(req: IncomingMessage): string | null {
  const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (!auth.trim()) {
    return null;
  }
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function normalizeInboundAttachments(input: unknown): Array<{
  type?: string;
  mimeType?: string;
  fileName?: string;
  content: string;
}> {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((item) => {
      const attachment = item as MuxInboundAttachment;
      const content =
        typeof attachment?.content === "string"
          ? attachment.content
          : ArrayBuffer.isView(attachment?.content)
            ? Buffer.from(
                attachment.content.buffer,
                attachment.content.byteOffset,
                attachment.content.byteLength,
              ).toString("base64")
            : undefined;
      if (!content) {
        return null;
      }
      return {
        type: typeof attachment?.type === "string" ? attachment.type : undefined,
        mimeType: typeof attachment?.mimeType === "string" ? attachment.mimeType : undefined,
        fileName: typeof attachment?.fileName === "string" ? attachment.fileName : undefined,
        content,
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveThreadId(
  threadId: unknown,
  channelData: Record<string, unknown> | undefined,
): string | number | undefined {
  if (typeof threadId === "number" && Number.isFinite(threadId)) {
    return Math.trunc(threadId);
  }
  if (typeof threadId === "string" && threadId.trim()) {
    return threadId.trim();
  }
  const topicId = channelData?.topicId;
  if (typeof topicId === "number" && Number.isFinite(topicId)) {
    return Math.trunc(topicId);
  }
  const rawThreadId = channelData?.threadId;
  if (typeof rawThreadId === "number" && Number.isFinite(rawThreadId)) {
    return Math.trunc(rawThreadId);
  }
  if (typeof rawThreadId === "string" && rawThreadId.trim()) {
    return rawThreadId.trim();
  }
  return undefined;
}

async function parseInboundImages(params: {
  message: string;
  attachments: Array<{
    type?: string;
    mimeType?: string;
    fileName?: string;
    content: string;
  }>;
  logWarn: (message: string) => void;
}): Promise<{ message: string; images: ChatImageContent[] }> {
  if (params.attachments.length === 0) {
    return { message: params.message, images: [] };
  }
  return await parseMessageWithAttachments(params.message, params.attachments, {
    maxBytes: 5_000_000,
    log: { warn: params.logWarn },
  });
}

export async function handleMuxInboundHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/v1/mux/inbound") {
    return false;
  }

  const cfg = loadConfig();
  const endpointCfg = cfg.gateway?.http?.endpoints?.mux;
  if (endpointCfg?.enabled !== true) {
    sendJson(res, 404, { ok: false, error: "not enabled" });
    return true;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const expectedToken = readOptionalString(endpointCfg.token);
  const providedToken = resolveBearerToken(req);
  if (!expectedToken || !providedToken || expectedToken !== providedToken) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }

  const maxBodyBytes =
    typeof endpointCfg.maxBodyBytes === "number" && endpointCfg.maxBodyBytes > 0
      ? endpointCfg.maxBodyBytes
      : DEFAULT_MUX_MAX_BODY_BYTES;
  const body = await readJsonBody(req, maxBodyBytes);
  if (!body.ok) {
    const status = body.error === "payload too large" ? 413 : 400;
    sendJson(res, status, { ok: false, error: body.error });
    return true;
  }

  const payload = (
    typeof body.value === "object" && body.value ? body.value : {}
  ) as MuxInboundPayload;
  const channel = normalizeChannelId(readOptionalString(payload.channel));
  const sessionKey = readOptionalString(payload.sessionKey);
  const originatingTo = readOptionalString(payload.to);
  const messageId = readOptionalString(payload.messageId ?? payload.eventId) ?? `mux:${Date.now()}`;
  const rawMessage = typeof payload.body === "string" ? payload.body : "";
  const attachments = normalizeInboundAttachments(payload.attachments);
  const channelData =
    payload.channelData && typeof payload.channelData === "object"
      ? payload.channelData
      : undefined;

  if (!channel) {
    sendJson(res, 400, { ok: false, error: "channel required" });
    return true;
  }
  if (!sessionKey) {
    sendJson(res, 400, { ok: false, error: "sessionKey required" });
    return true;
  }
  if (!originatingTo) {
    sendJson(res, 400, { ok: false, error: "to required" });
    return true;
  }
  if (!rawMessage.trim() && attachments.length === 0) {
    sendJson(res, 400, { ok: false, error: "body or attachment required" });
    return true;
  }

  let parsedMessage = rawMessage;
  let parsedImages: ChatImageContent[] = [];
  try {
    const parsed = await parseInboundImages({
      message: rawMessage,
      attachments,
      // Keep request handling resilient when non-image attachments are provided.
      logWarn: () => {},
    });
    parsedMessage = parsed.message;
    parsedImages = parsed.images;
  } catch (err) {
    sendJson(res, 400, { ok: false, error: String(err) });
    return true;
  }

  const ctx: MsgContext = {
    Body: parsedMessage,
    BodyForAgent: parsedMessage,
    BodyForCommands: parsedMessage,
    RawBody: parsedMessage,
    CommandBody: parsedMessage,
    SessionKey: sessionKey,
    From: readOptionalString(payload.from),
    To: originatingTo,
    AccountId: readOptionalString(payload.accountId),
    MessageSid: messageId,
    Timestamp: readOptionalNumber(payload.timestampMs),
    ChatType: readOptionalString(payload.chatType) ?? "direct",
    Provider: channel,
    Surface: "mux",
    OriginatingChannel: channel,
    OriginatingTo: originatingTo,
    MessageThreadId: resolveThreadId(payload.threadId, channelData),
    CommandAuthorized: true,
  };

  try {
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        // route-reply path handles outbound when OriginatingChannel differs from Surface.
      },
      onError: () => {
        // route-reply errors are surfaced in dispatch flow and logs.
      },
    });
    await dispatchInboundMessage({
      ctx,
      cfg,
      dispatcher,
      replyOptions: {
        ...(parsedImages.length > 0 ? { images: parsedImages } : {}),
      },
    });
    await dispatcher.waitForIdle();
    sendJson(res, 202, {
      ok: true,
      eventId: readOptionalString(payload.eventId) ?? messageId,
    });
    return true;
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err) });
    return true;
  }
}
