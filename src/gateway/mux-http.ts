import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { resolveAckReaction } from "../agents/identity.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  parseCommandArgs,
  resolveCommandArgMenu,
} from "../auto-reply/commands-registry.js";
import type { CommandArgs } from "../auto-reply/commands-registry.types.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { routeReply } from "../auto-reply/reply/route-reply.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { shouldAckReaction, type AckReactionScope } from "../channels/ack-reactions.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import {
  asMuxRecord,
  buildTelegramRawEditMessageText,
  normalizeMuxBaseUrl,
  normalizeMuxInboundAttachments,
  readMuxNonEmptyString,
  readMuxOptionalNumber,
  readMuxPositiveInt,
  readTelegramMessageThreadId,
  resolveMuxThreadId,
  toMuxInboundPayload,
  type MuxInboundAttachment,
  type MuxInboundPayload,
} from "../channels/plugins/mux-envelope.js";
import {
  fetchMuxFileStream,
  resolveMuxOpenClawId,
  sendTypingViaMux,
  sendViaMux,
} from "../channels/plugins/outbound/mux.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { logVerbose, warn } from "../globals.js";
import {
  resolveTelegramCallbackAction,
  type TelegramCallbackButtons,
} from "../telegram/callback-actions.js";
import { createTelegramStreamingDispatch } from "../telegram/draft-stream.js";
import {
  deleteMessageTelegram,
  editMessageTelegram,
  reactMessageTelegram,
  sendMessageTelegram,
  type MuxTransportOpts,
} from "../telegram/send.js";
import { readJsonBody } from "./hooks.js";
import { verifyMuxInboundJwt } from "./mux-jwt.js";

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

function resolveOpenClawIdHeader(req: IncomingMessage): string | null {
  const raw = req.headers["x-openclaw-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return readMuxNonEmptyString(value) ?? null;
}

async function authorizeMuxInboundRequest(params: {
  req: IncomingMessage;
  cfg: OpenClawConfig;
}): Promise<
  | { ok: true; openclawId: string }
  | { ok: false; statusCode: number; error: string; code?: string; details?: string }
> {
  const endpointCfg = params.cfg.gateway?.http?.endpoints?.mux;
  const providedToken = resolveBearerToken(params.req);
  if (!providedToken) {
    return { ok: false, statusCode: 401, error: "unauthorized", code: "MISSING_BEARER" };
  }

  const baseUrl = normalizeMuxBaseUrl(endpointCfg?.baseUrl);
  if (!baseUrl) {
    return { ok: false, statusCode: 500, error: "mux baseUrl is not configured" };
  }

  const openclawId = resolveMuxOpenClawId(params.cfg);
  const headerOpenClawId = resolveOpenClawIdHeader(params.req);
  if (!headerOpenClawId || headerOpenClawId !== openclawId) {
    return { ok: false, statusCode: 401, error: "unauthorized", code: "OPENCLAW_ID_MISMATCH" };
  }

  const verified = await verifyMuxInboundJwt({
    token: providedToken,
    openclawId,
    baseUrl,
  });
  if (!verified.ok) {
    return {
      ok: false,
      statusCode: 401,
      error: "unauthorized",
      code: "JWT_INVALID",
      details: verified.error,
    };
  }

  return { ok: true, openclawId };
}

function resolveTelegramCallbackPayload(params: {
  payload: MuxInboundPayload;
  channelData: Record<string, unknown> | undefined;
}): {
  data: string;
  chatId: string;
  callbackMessageId: number;
  messageThreadId?: number;
  isGroup: boolean;
  isForum: boolean;
  accountId?: string;
} | null {
  const eventKind = readMuxNonEmptyString(params.payload.event?.kind);
  if (eventKind !== "callback") {
    return null;
  }
  const telegramData = asMuxRecord(params.channelData?.telegram);
  const callbackData = readMuxNonEmptyString(telegramData?.callbackData);
  if (!callbackData) {
    return null;
  }
  const callbackMessageId = readMuxPositiveInt(telegramData?.callbackMessageId);
  if (!callbackMessageId) {
    return null;
  }

  const chatIdFromData = readMuxNonEmptyString(params.channelData?.chatId);
  const chatIdFromTo = readMuxNonEmptyString(params.payload.to)?.replace(/^telegram:/i, "");
  const chatId = chatIdFromData ?? chatIdFromTo;
  if (!chatId) {
    return null;
  }

  const rawMessage = asMuxRecord(telegramData?.rawMessage);
  const rawChat = asMuxRecord(rawMessage?.chat);
  const fallbackThreadId = resolveMuxThreadId(params.payload.threadId, params.channelData);
  const messageThreadId =
    readMuxPositiveInt(rawMessage?.message_thread_id) ??
    (typeof fallbackThreadId === "number"
      ? fallbackThreadId
      : readMuxPositiveInt(fallbackThreadId));
  return {
    data: callbackData,
    chatId,
    callbackMessageId,
    messageThreadId,
    isGroup: (readMuxNonEmptyString(params.payload.chatType) ?? "direct") !== "direct",
    isForum: rawChat?.is_forum === true,
    accountId: readMuxNonEmptyString(params.payload.accountId),
  };
}

async function sendTelegramEditViaMux(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  accountId?: string;
  messageId: number;
  text: string;
  buttons: TelegramCallbackButtons;
}) {
  const telegramEdit = buildTelegramRawEditMessageText({
    messageId: params.messageId,
    text: params.text,
    buttons: params.buttons,
  });
  await sendViaMux({
    cfg: params.cfg,
    channel: "telegram",
    sessionKey: params.sessionKey,
    accountId: params.accountId,
    raw: {
      telegram: telegramEdit,
    },
  });
}

function inferExtFromMime(mime: string | undefined): string {
  if (!mime) {
    return "";
  }
  const lower = mime.toLowerCase();
  if (lower === "image/jpeg") {
    return ".jpg";
  }
  if (lower === "image/png") {
    return ".png";
  }
  if (lower === "image/webp") {
    return ".webp";
  }
  if (lower === "image/gif") {
    return ".gif";
  }
  if (lower === "application/pdf") {
    return ".pdf";
  }
  if (lower === "audio/ogg" || lower === "audio/opus") {
    return ".ogg";
  }
  if (lower === "audio/mpeg") {
    return ".mp3";
  }
  if (lower === "video/mp4") {
    return ".mp4";
  }
  return "";
}

async function resolveAttachmentToTempFile(params: {
  attachment: MuxInboundAttachment;
  cfg: OpenClawConfig;
  tmpDir: string;
  index: number;
}): Promise<{ path: string; mimeType: string } | null> {
  const { attachment, cfg, tmpDir, index } = params;
  const ext = inferExtFromMime(attachment.mimeType) || path.extname(attachment.fileName || "");
  const baseName = attachment.fileName
    ? path.basename(attachment.fileName, path.extname(attachment.fileName))
    : `mux-att-${index}`;
  const tmpPath = path.join(tmpDir, `${baseName}-${index}${ext}`);
  const mimeType = attachment.mimeType || "application/octet-stream";

  if (attachment.url) {
    try {
      const response = await fetchMuxFileStream({ cfg, url: attachment.url });
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(tmpPath, buffer);
      return { path: tmpPath, mimeType };
    } catch {
      return null;
    }
  }

  if (attachment.content) {
    try {
      const raw = attachment.content.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(raw, "base64");
      if (buffer.byteLength === 0) {
        return null;
      }
      fs.writeFileSync(tmpPath, buffer);
      return { path: tmpPath, mimeType };
    } catch {
      return null;
    }
  }

  return null;
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

  const authorization = await authorizeMuxInboundRequest({ req, cfg });
  if (!authorization.ok) {
    sendJson(res, authorization.statusCode, {
      ok: false,
      error: authorization.error,
      ...(authorization.code ? { code: authorization.code } : {}),
      ...(authorization.details ? { details: authorization.details } : {}),
    });
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
  const payloadOpenClawId = readMuxNonEmptyString(payload.openclawId);
  if (!payloadOpenClawId || payloadOpenClawId !== authorization.openclawId) {
    sendJson(res, 401, { ok: false, error: "unauthorized", code: "PAYLOAD_OPENCLAW_ID_MISMATCH" });
    return true;
  }

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
  const callbackPayload =
    channel === "telegram" ? resolveTelegramCallbackPayload({ payload, channelData }) : null;
  if (!rawMessage.trim() && attachments.length === 0 && !callbackPayload) {
    sendJson(res, 400, { ok: false, error: "body or attachment required" });
    return true;
  }

  let inboundBody = rawMessage;
  if (callbackPayload) {
    try {
      const callbackAction = await resolveTelegramCallbackAction({
        cfg,
        accountId: callbackPayload.accountId,
        data: callbackPayload.data,
        chatId: callbackPayload.chatId,
        isGroup: callbackPayload.isGroup,
        isForum: callbackPayload.isForum,
        messageThreadId: callbackPayload.messageThreadId,
      });
      if (callbackAction.kind === "noop") {
        sendJson(res, 202, {
          ok: true,
          eventId: readMuxNonEmptyString(payload.eventId) ?? messageId,
        });
        return true;
      }
      if (callbackAction.kind === "edit") {
        await sendTelegramEditViaMux({
          cfg,
          sessionKey,
          accountId: callbackPayload.accountId,
          messageId: callbackPayload.callbackMessageId,
          text: callbackAction.text,
          buttons: callbackAction.buttons,
        });
        sendJson(res, 202, {
          ok: true,
          eventId: readMuxNonEmptyString(payload.eventId) ?? messageId,
        });
        return true;
      }
      inboundBody = callbackAction.text;
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
      return true;
    }
  }

  // For Telegram: set Surface = channel so dispatch-from-config delivers through our
  // callback instead of routing via routeReply (Surface matches OriginatingChannel).
  const isTelegramStreaming = channel === "telegram";
  const ctx: MsgContext = {
    Body: inboundBody,
    BodyForAgent: inboundBody,
    BodyForCommands: inboundBody,
    RawBody: inboundBody,
    CommandBody: inboundBody,
    SessionKey: sessionKey,
    From: readMuxNonEmptyString(payload.from),
    To: originatingTo,
    AccountId: readMuxNonEmptyString(payload.accountId),
    MessageSid: messageId,
    Timestamp: readMuxOptionalNumber(payload.timestampMs),
    ChatType: readMuxNonEmptyString(payload.chatType) ?? "direct",
    Provider: channel,
    Surface: isTelegramStreaming ? channel : "mux",
    OriginatingChannel: channel,
    OriginatingTo: originatingTo,
    MessageThreadId: resolveMuxThreadId(payload.threadId, channelData),
    WasMentioned: payload.wasMentioned === true,
    ChannelData: {
      ...channelData,
      ...(isTelegramStreaming ? { inboundTransport: "mux" } : {}),
    },
    CommandAuthorized: true,
  };

  const dispatchPromise = (async () => {
    let tmpDir: string | undefined;
    try {
      // Resolve attachments to temp files (same pattern as vanilla TG channel).
      if (attachments.length > 0) {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-att-"));
        const resolved = await Promise.all(
          attachments.map((att, i) =>
            resolveAttachmentToTempFile({ attachment: att, cfg, tmpDir: tmpDir!, index: i }),
          ),
        );
        const mediaPaths: string[] = [];
        const mediaTypes: string[] = [];
        for (const r of resolved) {
          if (r) {
            mediaPaths.push(r.path);
            mediaTypes.push(r.mimeType);
          }
        }
        if (mediaPaths.length > 0) {
          ctx.MediaPath = mediaPaths[0];
          ctx.MediaUrl = mediaPaths[0];
          ctx.MediaType = mediaTypes[0];
          ctx.MediaPaths = mediaPaths;
          ctx.MediaUrls = mediaPaths;
          ctx.MediaTypes = mediaTypes;
        }
      }

      let markDispatchIdle: (() => void) | undefined;
      const typingChannel: "telegram" | "discord" | "whatsapp" | null =
        channel === "telegram"
          ? "telegram"
          : channel === "discord"
            ? "discord"
            : channel === "whatsapp"
              ? "whatsapp"
              : null;
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

      if (isTelegramStreaming) {
        await dispatchMuxTelegram({
          ctx,
          cfg,
          sessionKey,
          originatingTo,
          channelData,
          messageId,
          onReplyStart,
          onMarkDispatchIdle: (fn) => {
            markDispatchIdle = fn;
          },
        });
        markDispatchIdle?.();
      } else {
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
      }
    } catch (err) {
      warn(`mux inbound attachment resolve failed messageId=${messageId}: ${String(err)}`);
    } finally {
      // Clean up temp files.
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  })();

  void dispatchPromise;
  sendJson(res, 202, {
    ok: true,
    eventId: readMuxNonEmptyString(payload.eventId) ?? messageId,
  });
  return true;
}

async function dispatchMuxTelegram(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  sessionKey: string;
  originatingTo: string;
  channelData: Record<string, unknown> | undefined;
  messageId: string;
  onReplyStart?: () => Promise<void>;
  onMarkDispatchIdle: (fn: () => void) => void;
}): Promise<void> {
  const { ctx, cfg, sessionKey, originatingTo, channelData, messageId, onReplyStart } = params;
  const messageThreadId = readTelegramMessageThreadId(
    resolveMuxThreadId(ctx.MessageThreadId, channelData),
  );

  const mux: MuxTransportOpts = { cfg, sessionKey, accountId: ctx.AccountId };

  // Mirror direct-path command menu interception (bot-native-commands.ts:510-540).
  // When a command has argsMenu: "auto" and no args are provided, send inline
  // keyboard buttons and return early — identical to what the grammY handler does.
  const body = (ctx.Body ?? "").trim();
  const commandMatch = body.match(/^\/([a-z0-9_]+)(?:@\S+)?\s*(.*)/i);
  if (commandMatch) {
    const [, commandName, rawArgs] = commandMatch;
    const commandDef = findCommandByNativeName(commandName, "telegram");
    if (commandDef) {
      const commandArgs = parseCommandArgs(commandDef, rawArgs.trim());
      const menu = resolveCommandArgMenu({ command: commandDef, args: commandArgs, cfg });
      if (menu) {
        const title =
          menu.title ??
          `Choose ${menu.arg.description || menu.arg.name} for /${commandDef.nativeName ?? commandDef.key}.`;
        const rows: Array<Array<{ text: string; callback_data: string }>> = [];
        for (let i = 0; i < menu.choices.length; i += 2) {
          rows.push(
            menu.choices.slice(i, i + 2).map((choice) => {
              const args: CommandArgs = { values: { [menu.arg.name]: choice.value } };
              return {
                text: choice.label,
                callback_data: buildCommandTextFromArgs(commandDef, args),
              };
            }),
          );
        }
        await sendMessageTelegram(originatingTo, title, {
          textMode: "html",
          messageThreadId,
          buttons: rows,
          mux,
        });
        return;
      }
    }
  }

  // Draft stream transport — mirrors direct path (bot-message-dispatch.ts):
  //   • send() and edit() use plain text (no parse_mode) during streaming
  //   • send() includes reply_parameters pointing to the inbound message
  //   • finalization editFn uses textMode: "html" (via editMessageTelegram)
  const inboundMessageId = readMuxPositiveInt(messageId);
  const streaming = createTelegramStreamingDispatch({
    transport: {
      send: async (text) => {
        const result = await sendViaMux({
          cfg,
          channel: "telegram",
          sessionKey,
          accountId: ctx.AccountId,
          raw: {
            telegram: {
              method: "sendMessage",
              body: {
                text,
                ...(messageThreadId != null ? { message_thread_id: messageThreadId } : {}),
                ...(inboundMessageId != null
                  ? { reply_parameters: { message_id: inboundMessageId } }
                  : {}),
              },
            },
          },
        });
        return { messageId: Number(result.messageId) };
      },
      edit: async (msgId, text) => {
        await sendViaMux({
          cfg,
          channel: "telegram",
          sessionKey,
          accountId: ctx.AccountId,
          raw: {
            telegram: {
              method: "editMessageText",
              body: {
                message_id: msgId,
                text,
              },
            },
          },
        });
      },
      delete: async (msgId) => {
        await deleteMessageTelegram(originatingTo, msgId, { mux });
      },
    },
    editFn: async (msgId, text) => {
      await editMessageTelegram(originatingTo, msgId, text, { mux });
    },
    log: logVerbose,
    warn: logVerbose,
  });

  // Fire-and-forget ack reaction — gated by ackReactionScope (same policy as direct path).
  const ackScope = (cfg.messages?.ackReactionScope ?? "group-mentions") as AckReactionScope;
  const isDirect = ctx.ChatType === "direct";
  const isGroup = !isDirect;
  if (
    shouldAckReaction({
      scope: ackScope,
      isDirect,
      isGroup,
      isMentionableGroup: isGroup,
      requireMention: true,
      canDetectMention: true,
      effectiveWasMentioned: ctx.WasMentioned === true,
      shouldBypassMention: false,
    })
  ) {
    const ackEmoji = resolveAckReaction(cfg, "default", {
      channel: "telegram",
      accountId: ctx.AccountId,
    });
    if (ackEmoji) {
      void reactMessageTelegram(originatingTo, Number(messageId), ackEmoji, { mux }).catch(
        () => {},
      );
    }
  }

  let markDispatchIdle: (() => void) | undefined;
  try {
    await dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        deliver: async (payload, info) => {
          if (info.kind === "final" && (await streaming.tryFinalize(payload))) {
            return;
          }
          // Fallback: send via routeReply (routes through mux outbound adapter).
          await routeReply({
            payload,
            channel: "telegram",
            to: originatingTo,
            sessionKey,
            accountId: ctx.AccountId,
            threadId: ctx.MessageThreadId,
            cfg,
          });
        },
        onError: (err) => {
          warn(`mux telegram reply failed: ${String(err)}`);
        },
        ...(onReplyStart ? { onReplyStart } : {}),
      },
      replyOptions: {
        disableBlockStreaming: true,
        onPartialReply: streaming.onPartialReply,
        onTypingController: (typing) => {
          markDispatchIdle = () => typing.markDispatchIdle();
          params.onMarkDispatchIdle(markDispatchIdle);
        },
      },
    });
  } catch (err) {
    warn(`mux inbound dispatch failed messageId=${messageId}: ${String(err)}`);
  } finally {
    await streaming.cleanup();
  }
}
