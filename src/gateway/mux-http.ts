import type { IncomingMessage, ServerResponse } from "node:http";
import type { MsgContext } from "../auto-reply/templating.js";
import type { ChatImageContent } from "./chat-attachments.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import {
  asMuxRecord,
  normalizeMuxInboundAttachments,
  readMuxNonEmptyString,
  readMuxOptionalNumber,
  resolveMuxThreadId,
  toMuxInboundPayload,
} from "../channels/plugins/mux-envelope.js";
import { sendTypingViaMux } from "../channels/plugins/outbound/mux.js";
import { loadConfig } from "../config/config.js";
import { warn } from "../globals.js";
import { parseMessageWithAttachments } from "./chat-attachments.js";
import { readJsonBody } from "./hooks.js";

const DEFAULT_MUX_MAX_BODY_BYTES = 10 * 1024 * 1024;

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

async function parseInboundImages(params: {
  message: string;
  attachments: Array<{
    type?: string;
    mimeType?: string;
    fileName?: string;
    content: string;
  }>;
  logWarn: (message: string) => void;
}): Promise<ChatImageContent[]> {
  if (params.attachments.length === 0) {
    return [];
  }
  const parsed = await parseMessageWithAttachments(params.message, params.attachments, {
    maxBytes: 5_000_000,
    log: { warn: params.logWarn },
  });
  // Transport layer contract: parse attachments, but never rewrite inbound text.
  return parsed.images;
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

  const expectedToken = readMuxNonEmptyString(endpointCfg.token);
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

  const payload = toMuxInboundPayload(body.value);
  const channel = normalizeChannelId(readMuxNonEmptyString(payload.channel));
  const sessionKey = readMuxNonEmptyString(payload.sessionKey);
  const originatingTo = readMuxNonEmptyString(payload.to);
  const messageId =
    readMuxNonEmptyString(payload.messageId ?? payload.eventId) ?? `mux:${Date.now()}`;
  const rawMessage = typeof payload.body === "string" ? payload.body : "";
  const attachments = normalizeMuxInboundAttachments(payload.attachments);
  const channelData = asMuxRecord(payload.channelData);

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

  const ctx: MsgContext = {
    Body: rawMessage,
    BodyForAgent: rawMessage,
    BodyForCommands: rawMessage,
    RawBody: rawMessage,
    CommandBody: rawMessage,
    SessionKey: sessionKey,
    From: readMuxNonEmptyString(payload.from),
    To: originatingTo,
    AccountId: readMuxNonEmptyString(payload.accountId),
    MessageSid: messageId,
    Timestamp: readMuxOptionalNumber(payload.timestampMs),
    ChatType: readMuxNonEmptyString(payload.chatType) ?? "direct",
    Provider: channel,
    Surface: "mux",
    OriginatingChannel: channel,
    OriginatingTo: originatingTo,
    MessageThreadId: resolveMuxThreadId(payload.threadId, channelData),
    ChannelData: channelData,
    CommandAuthorized: true,
  };

  const dispatchPromise = (async () => {
    let parsedImages: ChatImageContent[] = [];
    try {
      parsedImages = await parseInboundImages({
        message: rawMessage,
        attachments,
        // Keep request handling resilient when non-image attachments are provided.
        logWarn: () => {},
      });
    } catch (err) {
      warn(`mux inbound attachment parse failed messageId=${messageId}: ${String(err)}`);
      return;
    }

    let markDispatchIdle: (() => void) | undefined;
    const typingChannel =
      channel === "telegram" || channel === "discord" || channel === "whatsapp" ? channel : null;
    const onReplyStart = typingChannel
      ? async () => {
          try {
            await sendTypingViaMux({
              cfg,
              channel: typingChannel,
              accountId: ctx.AccountId,
              sessionKey,
            });
          } catch {
            // Best-effort typing signal for mux transport.
          }
        }
      : undefined;
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        // route-reply path handles outbound when OriginatingChannel differs from Surface.
      },
      onError: () => {
        // route-reply errors are surfaced in dispatch flow and logs.
      },
    });
    try {
      await dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          ...(parsedImages.length > 0 ? { images: parsedImages } : {}),
          ...(onReplyStart ? { onReplyStart } : {}),
          onTypingController: (typing) => {
            markDispatchIdle = () => typing.markDispatchIdle();
          },
        },
      });
      await dispatcher.waitForIdle();
    } catch (err) {
      warn(`mux inbound dispatch failed messageId=${messageId}: ${String(err)}`);
    } finally {
      markDispatchIdle?.();
    }
  })();

  void dispatchPromise;
  sendJson(res, 202, {
    ok: true,
    eventId: readMuxNonEmptyString(payload.eventId) ?? messageId,
  });
  return true;
}
