import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { resolveAckReaction } from "../agents/identity.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  parseCommandArgs,
  resolveCommandArgMenu,
  resolveTextCommand,
} from "../auto-reply/commands-registry.js";
import type { CommandArgs } from "../auto-reply/commands-registry.types.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { resolveReplyToMode } from "../auto-reply/reply/reply-threading.js";
import { routeReply } from "../auto-reply/reply/route-reply.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { shouldAckReaction, type AckReactionScope } from "../channels/ack-reactions.js";
import { resolveControlCommandGate } from "../channels/command-gating.js";
import { resolveMentionGatingWithBypass } from "../channels/mention-gating.js";
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
import { normalizeChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../config/group-policy.js";
import type { TelegramGroupConfig, TelegramTopicConfig } from "../config/types.telegram.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordMemberAccessState,
  resolveDiscordShouldRequireMention,
  allowListMatches,
  normalizeDiscordSlug,
  type DiscordGuildEntryResolved,
} from "../discord/monitor/allow-list.js";
import { logVerbose, warn } from "../globals.js";
import {
  addChannelAllowFromStoreEntry,
  readChannelAllowFromStore,
} from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { resolveTelegramAccount } from "../telegram/accounts.js";
import {
  firstDefined,
  isSenderAllowed,
  normalizeAllowFromWithStore,
  resolveSenderAllowMatch,
} from "../telegram/bot-access.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramGroupAllowFromContext,
  resolveTelegramForumThreadId,
} from "../telegram/bot/helpers.js";
import {
  resolveTelegramCallbackAction,
  type TelegramCallbackButtons,
} from "../telegram/callback-actions.js";
import { createTelegramStreamingDispatch } from "../telegram/draft-stream.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "../telegram/group-access.js";
import {
  buildTelegramThreadReplyParams,
  deleteMessageTelegram,
  editMessageTelegram,
  reactMessageTelegram,
  sendMessageTelegram,
  type MuxTransportOpts,
} from "../telegram/send.js";
import { normalizeE164 } from "../utils.js";
import { isMuxBusinessChannel, resolveMuxBusinessAccountId } from "../utils/mux-account.js";
import { resolveWhatsAppAccount } from "../web/accounts.js";
import { normalizeWhatsAppTarget, isWhatsAppGroupJid } from "../whatsapp/normalize.js";
import { readJsonBody } from "./hooks.js";
import { verifyMuxInboundJwt } from "./mux-jwt.js";
import { addMuxPairedSender, readMuxPairedSenders } from "./mux-paired-senders.js";

const DEFAULT_MUX_MAX_BODY_BYTES = 10 * 1024 * 1024;

type MuxAccessResult =
  | { allowed: false }
  | { allowed: true; commandAuthorized: boolean; effectiveWasMentioned?: boolean };

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

function isDirectChat(chatType: string | undefined): boolean {
  return (chatType ?? "direct") === "direct";
}

function resolveMuxChatType(chatType: string | undefined): string {
  return isDirectChat(chatType) ? "direct" : (chatType ?? "direct");
}

function readMuxStringishId(value: unknown): string | undefined {
  return (
    readMuxNonEmptyString(value) ??
    (typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : undefined)
  );
}

function sanitizeDiscordRoleId(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return "";
}

function resolveTelegramMuxMessageData(channelData: Record<string, unknown> | undefined): {
  telegramData: Record<string, unknown> | undefined;
  rawMessage: Record<string, unknown> | undefined;
  rawChat: Record<string, unknown> | undefined;
} {
  const telegramData = asMuxRecord(channelData?.telegram);
  const rawMessage = asMuxRecord(telegramData?.rawMessage);
  const rawChat = asMuxRecord(rawMessage?.chat);
  return { telegramData, rawMessage, rawChat };
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
  accountId: string;
}): {
  data: string;
  chatId: string;
  callbackMessageId: number;
  messageThreadId?: number;
  isGroup: boolean;
  isForum: boolean;
  accountId: string;
} | null {
  const eventKind = readMuxNonEmptyString(params.payload.event?.kind);
  if (eventKind !== "callback") {
    return null;
  }
  const { telegramData, rawMessage, rawChat } = resolveTelegramMuxMessageData(params.channelData);
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
    isGroup: !isDirectChat(readMuxNonEmptyString(params.payload.chatType)),
    isForum: rawChat?.is_forum === true,
    accountId: params.accountId,
  };
}

function stripMuxProviderPrefix(raw: string, provider: string): string {
  const trimmed = raw.trim();
  const prefix = `${provider.toLowerCase()}:`;
  return trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
}

function resolveTelegramInboundPeer(params: {
  payload: MuxInboundPayload;
  channelData: Record<string, unknown> | undefined;
}): {
  chatId: string;
  isGroup: boolean;
  isForum: boolean;
  messageThreadId?: number;
} | null {
  const chatIdFromData = readMuxNonEmptyString(params.channelData?.chatId);
  const chatIdFromTo = readMuxNonEmptyString(params.payload.to)?.replace(/^(telegram|tg):/i, "");
  const chatId = chatIdFromData ?? chatIdFromTo;
  if (!chatId) {
    return null;
  }

  const { rawMessage, rawChat } = resolveTelegramMuxMessageData(params.channelData);
  const fallbackThreadId = resolveMuxThreadId(params.payload.threadId, params.channelData);
  const messageThreadId =
    readMuxPositiveInt(rawMessage?.message_thread_id) ??
    (typeof fallbackThreadId === "number"
      ? fallbackThreadId
      : readMuxPositiveInt(fallbackThreadId));
  return {
    chatId,
    isGroup: !isDirectChat(readMuxNonEmptyString(params.payload.chatType)),
    isForum: rawChat?.is_forum === true,
    messageThreadId,
  };
}

function resolveDiscordInboundPeerId(params: {
  payload: MuxInboundPayload;
  channelData: Record<string, unknown> | undefined;
}): { kind: "direct" | "group" | "channel"; id: string; guildId?: string } | null {
  const guildId = readMuxNonEmptyString(params.channelData?.guildId);
  const isDirect = isDirectChat(readMuxNonEmptyString(params.payload.chatType));
  if (isDirect) {
    const from = readMuxNonEmptyString(params.payload.from);
    if (!from) {
      return null;
    }
    const peerId = stripMuxProviderPrefix(from, "discord")
      .replace(/^(user|dm):/i, "")
      .trim();
    return peerId ? { kind: "direct", id: peerId } : null;
  }

  const channelIdFromData = readMuxNonEmptyString(params.channelData?.channelId);
  const channelIdFromTo = readMuxNonEmptyString(params.payload.to);
  const channelId = channelIdFromData
    ? channelIdFromData
    : channelIdFromTo
      ? stripMuxProviderPrefix(channelIdFromTo, "discord")
          .replace(/^channel:/i, "")
          .trim()
      : undefined;
  if (!channelId) {
    return null;
  }
  return {
    kind: guildId ? "channel" : "group",
    id: channelId,
    guildId: guildId ?? undefined,
  };
}

function resolveMuxInboundOriginatingTarget(params: {
  channel: "telegram" | "discord" | "whatsapp";
  payload: MuxInboundPayload;
  channelData: Record<string, unknown> | undefined;
}): string | null {
  if (params.channel === "discord") {
    const peer = resolveDiscordInboundPeerId({
      payload: params.payload,
      channelData: params.channelData,
    });
    if (!peer) {
      return null;
    }
    return peer.kind === "direct" ? `user:${peer.id}` : `channel:${peer.id}`;
  }
  return readMuxNonEmptyString(params.payload.to) ?? null;
}

function resolveDiscordMuxSender(params: {
  payload: MuxInboundPayload;
  channelData: Record<string, unknown> | undefined;
}): { senderId?: string; senderName?: string; senderTag?: string; memberRoleIds: string[] } {
  const discordData = asMuxRecord(params.channelData?.discord);
  const rawMessage = asMuxRecord(discordData?.rawMessage);
  const author = asMuxRecord(rawMessage?.author);
  const member = asMuxRecord(rawMessage?.member);
  const senderId =
    readMuxStringishId(author?.id) ??
    readMuxNonEmptyString(params.payload.from)?.replace(/^discord:(user:|dm:)?/i, "");
  const senderName =
    readMuxNonEmptyString(author?.username) ?? readMuxNonEmptyString(author?.global_name);
  const discriminator = readMuxNonEmptyString(author?.discriminator);
  const senderTag = senderName
    ? discriminator && discriminator !== "0"
      ? `${senderName}#${discriminator}`
      : senderName
    : undefined;
  const rawRoles = Array.isArray(member?.roles) ? member.roles : [];
  const memberRoleIds = rawRoles.map(sanitizeDiscordRoleId).filter(Boolean);
  return {
    senderId,
    senderName,
    senderTag,
    memberRoleIds,
  };
}

function resolveDiscordGuildInfo(params: {
  cfg: OpenClawConfig;
  guildId?: string;
}): DiscordGuildEntryResolved | null {
  if (!params.guildId) {
    return null;
  }
  const guildEntries = params.cfg.channels?.discord?.guilds;
  if (!guildEntries) {
    return null;
  }
  const match =
    guildEntries[params.guildId] ??
    guildEntries[normalizeDiscordSlug(params.guildId)] ??
    guildEntries["*"];
  if (!match) {
    return null;
  }
  return {
    ...match,
    id: params.guildId,
    slug: normalizeDiscordSlug(params.guildId),
  };
}

function parseDiscordParentChannelIdFromRouteKey(routeKey: string | undefined): string | undefined {
  const trimmed = readMuxNonEmptyString(routeKey);
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^discord:[^:]+:guild:[^:]+:channel:([^:]+):thread:[^:]+$/i);
  return match?.[1]?.trim() || undefined;
}

function resolveWhatsAppInboundPeerId(params: { payload: MuxInboundPayload }): {
  kind: "direct" | "group";
  id: string;
} | null {
  const isGroup = !isDirectChat(readMuxNonEmptyString(params.payload.chatType));
  const groupTarget = normalizeWhatsAppTarget(readMuxNonEmptyString(params.payload.to) ?? "");
  if (isGroup && groupTarget && isWhatsAppGroupJid(groupTarget)) {
    return { kind: "group", id: groupTarget };
  }
  const directTarget =
    normalizeWhatsAppTarget(readMuxNonEmptyString(params.payload.from) ?? "") ??
    normalizeWhatsAppTarget(readMuxNonEmptyString(params.payload.to) ?? "");
  if (!directTarget) {
    return null;
  }
  return {
    kind: isWhatsAppGroupJid(directTarget) ? "group" : "direct",
    id: directTarget,
  };
}

function normalizeWhatsAppAllowList(values: string[] | undefined): {
  hasEntries: boolean;
  hasWildcard: boolean;
  entries: string[];
} {
  const list = Array.isArray(values) ? values : [];
  const hasWildcard = list.some((entry) => String(entry).trim() === "*");
  const entries = list.map((entry) => normalizeE164(String(entry).trim())).filter(Boolean);
  return {
    hasEntries: hasWildcard || entries.length > 0,
    hasWildcard,
    entries,
  };
}

function resolveMuxInboundBusinessSessionKey(params: {
  cfg: OpenClawConfig;
  channel: "telegram" | "discord" | "whatsapp";
  payload: MuxInboundPayload;
  channelData: Record<string, unknown> | undefined;
  accountId: string;
  fallbackSessionKey: string;
}): string {
  if (params.channel === "telegram") {
    const peer = resolveTelegramInboundPeer({
      payload: params.payload,
      channelData: params.channelData,
    });
    if (!peer) {
      return params.fallbackSessionKey;
    }
    const resolvedThreadId = resolveTelegramForumThreadId({
      isForum: peer.isForum,
      messageThreadId: peer.messageThreadId,
    });
    const route = resolveAgentRoute({
      cfg: params.cfg,
      channel: "telegram",
      accountId: params.accountId,
      peer: {
        kind: peer.isGroup ? "group" : "direct",
        id: peer.isGroup ? buildTelegramGroupPeerId(peer.chatId, resolvedThreadId) : peer.chatId,
      },
      parentPeer: buildTelegramParentPeer({
        isGroup: peer.isGroup,
        resolvedThreadId,
        chatId: peer.chatId,
      }),
    });
    if (!peer.isGroup && peer.messageThreadId != null) {
      return resolveThreadSessionKeys({
        baseSessionKey: route.sessionKey,
        threadId: String(peer.messageThreadId),
      }).sessionKey;
    }
    return route.sessionKey;
  }

  if (params.channel === "discord") {
    const peer = resolveDiscordInboundPeerId({
      payload: params.payload,
      channelData: params.channelData,
    });
    if (!peer) {
      return params.fallbackSessionKey;
    }
    return resolveAgentRoute({
      cfg: params.cfg,
      channel: "discord",
      accountId: params.accountId,
      guildId: peer.guildId,
      peer: { kind: peer.kind, id: peer.id },
    }).sessionKey;
  }

  const peer = resolveWhatsAppInboundPeerId({ payload: params.payload });
  if (!peer) {
    return params.fallbackSessionKey;
  }
  return resolveAgentRoute({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: params.accountId,
    peer: { kind: peer.kind, id: peer.id },
  }).sessionKey;
}

function isMuxPostPairingSynthetic(params: {
  payload: MuxInboundPayload;
  channelData: Record<string, unknown> | undefined;
  messageId: string;
}): boolean {
  const pairing = asMuxRecord(params.channelData?.pairing);
  if (readMuxNonEmptyString(pairing?.kind)?.toLowerCase() === "post-pair") {
    return true;
  }
  return params.messageId.startsWith("synth:pair:");
}

function resolveTelegramMuxSender(params: {
  payload: MuxInboundPayload;
  channelData: Record<string, unknown> | undefined;
}): { senderId?: string; senderUsername?: string } {
  const { rawMessage } = resolveTelegramMuxMessageData(params.channelData);
  const from = asMuxRecord(rawMessage?.from);
  const senderId =
    readMuxStringishId(from?.id) ??
    readMuxNonEmptyString(params.payload.from)?.replace(/^(telegram|tg):/i, "");
  const senderUsername = readMuxNonEmptyString(from?.username);
  return {
    senderId,
    senderUsername,
  };
}

function resolveTelegramMuxGroupConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: string | number;
  messageThreadId?: number;
}): {
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
} {
  const telegramCfg = resolveTelegramAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  }).config;
  const groups = telegramCfg.groups;
  if (!groups) {
    return { groupConfig: undefined, topicConfig: undefined };
  }
  const groupKey = String(params.chatId);
  const groupConfig = groups[groupKey] ?? groups["*"];
  const topicConfig =
    params.messageThreadId != null
      ? groupConfig?.topics?.[String(params.messageThreadId)]
      : undefined;
  return { groupConfig, topicConfig };
}

async function bootstrapMuxPairedSender(params: {
  channel: "telegram" | "discord" | "whatsapp";
  accountId: string;
  payload: MuxInboundPayload;
  channelData: Record<string, unknown> | undefined;
  messageId: string;
  chatType: string;
}): Promise<void> {
  if (
    !isMuxPostPairingSynthetic({
      payload: params.payload,
      channelData: params.channelData,
      messageId: params.messageId,
    })
  ) {
    return;
  }

  const routeKey = readMuxNonEmptyString(params.channelData?.routeKey);
  const senderId =
    params.channel === "telegram"
      ? resolveTelegramMuxSender({
          payload: params.payload,
          channelData: params.channelData,
        }).senderId
      : readMuxNonEmptyString(params.payload.from)
          ?.replace(/^(discord:(user|dm):|discord:|whatsapp:)/i, "")
          .trim();
  if (!senderId) {
    return;
  }

  if (isDirectChat(params.chatType)) {
    try {
      await addChannelAllowFromStoreEntry({
        channel: params.channel,
        entry: senderId,
        accountId: params.accountId,
      });
    } catch (error) {
      warn(
        `[mux] failed to persist paired DM sender for ${params.channel}:${params.accountId}: ${(error as Error).message}`,
      );
    }
    return;
  }

  if (!routeKey) {
    return;
  }
  try {
    await addMuxPairedSender({
      channel: params.channel,
      accountId: params.accountId,
      routeKey,
      senderId,
    });
  } catch (error) {
    warn(
      `[mux] failed to persist paired sender for ${params.channel}:${params.accountId}:${routeKey}: ${(error as Error).message}`,
    );
  }
}

async function resolveTelegramMuxAccess(params: {
  cfg: OpenClawConfig;
  accountId: string;
  payload: MuxInboundPayload;
  channelData: Record<string, unknown> | undefined;
  body: string;
  chatType: string;
  messageId: string;
  wasMentioned: boolean;
}): Promise<MuxAccessResult> {
  const telegramAccount = resolveTelegramAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const telegramCfg = telegramAccount.config;
  const sender = resolveTelegramMuxSender({
    payload: params.payload,
    channelData: params.channelData,
  });
  const isGroup = !isDirectChat(params.chatType);
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;

  if (!isGroup) {
    const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
    if (dmPolicy === "disabled") {
      return { allowed: false };
    }
    const storeAllowFrom = await readChannelAllowFromStore(
      "telegram",
      process.env,
      params.accountId,
    ).catch(() => []);
    const effectiveDmAllow = normalizeAllowFromWithStore({
      allowFrom: telegramCfg.allowFrom,
      storeAllowFrom,
    });
    if (!effectiveDmAllow.hasEntries) {
      return { allowed: true, commandAuthorized: true };
    }
    if (dmPolicy !== "open") {
      const allowMatch = resolveSenderAllowMatch({
        allow: effectiveDmAllow,
        senderId: sender.senderId,
        senderUsername: sender.senderUsername,
      });
      const allowed =
        effectiveDmAllow.hasWildcard || (effectiveDmAllow.hasEntries && allowMatch.allowed);
      if (!allowed) {
        return { allowed: false };
      }
    }
    const commandAuthorized = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        {
          configured: effectiveDmAllow.hasEntries,
          allowed: isSenderAllowed({
            allow: effectiveDmAllow,
            senderId: sender.senderId,
            senderUsername: sender.senderUsername,
          }),
        },
      ],
      allowTextCommands: true,
      hasControlCommand: hasControlCommand(params.body, params.cfg, {}),
    }).commandAuthorized;
    return { allowed: true, commandAuthorized };
  }

  const peer = resolveTelegramInboundPeer({
    payload: params.payload,
    channelData: params.channelData,
  });
  if (!peer) {
    return { allowed: false };
  }
  const groupAllowFrom =
    telegramCfg.groupAllowFrom ??
    (telegramCfg.allowFrom && telegramCfg.allowFrom.length > 0 ? telegramCfg.allowFrom : undefined);
  const groupAllowContext = await resolveTelegramGroupAllowFromContext({
    chatId: peer.chatId,
    accountId: params.accountId,
    isForum: peer.isForum,
    messageThreadId: peer.messageThreadId,
    groupAllowFrom,
    resolveTelegramGroupConfig: (chatId, messageThreadId) =>
      resolveTelegramMuxGroupConfig({
        cfg: params.cfg,
        accountId: params.accountId,
        chatId,
        messageThreadId,
      }),
  });
  const routeKey =
    readMuxNonEmptyString(params.channelData?.routeKey) ?? `telegram:default:chat:${peer.chatId}`;
  const pairedSenders = await readMuxPairedSenders({
    channel: "telegram",
    accountId: params.accountId,
    routeKey,
  }).catch(() => []);
  const runtimePairedSenders = groupAllowContext.hasGroupAllowOverride ? [] : pairedSenders;
  const effectiveGroupAllow = normalizeAllowFromWithStore({
    allowFrom: groupAllowContext.groupAllowOverride ?? groupAllowFrom,
    storeAllowFrom: [...groupAllowContext.storeAllowFrom, ...runtimePairedSenders],
  });
  const baseAccess = evaluateTelegramGroupBaseAccess({
    isGroup: true,
    groupConfig: groupAllowContext.groupConfig,
    topicConfig: groupAllowContext.topicConfig,
    hasGroupAllowOverride: groupAllowContext.hasGroupAllowOverride,
    effectiveGroupAllow,
    senderId: sender.senderId,
    senderUsername: sender.senderUsername,
    enforceAllowOverride: true,
    requireSenderForAllowOverride: false,
  });
  if (!baseAccess.allowed) {
    return { allowed: false };
  }

  const policyAccess = evaluateTelegramGroupPolicyAccess({
    isGroup: true,
    chatId: peer.chatId,
    cfg: params.cfg,
    telegramCfg,
    topicConfig: groupAllowContext.topicConfig,
    groupConfig: groupAllowContext.groupConfig,
    effectiveGroupAllow,
    senderId: sender.senderId,
    senderUsername: sender.senderUsername,
    resolveGroupPolicy: (chatId) =>
      resolveChannelGroupPolicy({
        cfg: params.cfg,
        channel: "telegram",
        accountId: params.accountId,
        groupId: String(chatId),
      }),
    enforcePolicy: true,
    useTopicAndGroupOverrides: true,
    enforceAllowlistAuthorization: true,
    allowEmptyAllowlistEntries: false,
    requireSenderForAllowlistAuthorization: true,
    checkChatAllowlist: false,
  });
  if (!policyAccess.allowed) {
    return { allowed: false };
  }

  const requireMention =
    firstDefined(
      groupAllowContext.topicConfig?.requireMention,
      groupAllowContext.groupConfig?.requireMention,
      resolveChannelGroupRequireMention({
        cfg: params.cfg,
        channel: "telegram",
        accountId: params.accountId,
        groupId: String(peer.chatId),
      }),
    ) ?? false;
  const commandAuthorized = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: effectiveGroupAllow.hasEntries,
        allowed: isSenderAllowed({
          allow: effectiveGroupAllow,
          senderId: sender.senderId,
          senderUsername: sender.senderUsername,
        }),
      },
    ],
    allowTextCommands: true,
    hasControlCommand: hasControlCommand(params.body, params.cfg, {}),
  }).commandAuthorized;
  const mentionGate = resolveMentionGatingWithBypass({
    isGroup: true,
    requireMention,
    canDetectMention: true,
    wasMentioned: params.wasMentioned,
    hasAnyMention: params.wasMentioned,
    allowTextCommands: true,
    hasControlCommand: hasControlCommand(params.body, params.cfg, {}),
    commandAuthorized,
  });
  if (mentionGate.shouldSkip) {
    return { allowed: false };
  }
  return {
    allowed: true,
    commandAuthorized,
    effectiveWasMentioned: mentionGate.effectiveWasMentioned,
  };
}

async function resolveDiscordMuxAccess(params: {
  cfg: OpenClawConfig;
  accountId: string;
  payload: MuxInboundPayload;
  channelData: Record<string, unknown> | undefined;
  body: string;
  chatType: string;
  wasMentioned: boolean;
}): Promise<MuxAccessResult> {
  const discordCfg = params.cfg.channels?.discord ?? {};
  const hasControlCommandInMessage = hasControlCommand(params.body, params.cfg, {});
  const sender = resolveDiscordMuxSender({
    payload: params.payload,
    channelData: params.channelData,
  });
  const isDirect = isDirectChat(params.chatType);
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;

  if (isDirect) {
    const dmPolicy = discordCfg.dmPolicy ?? discordCfg.dm?.policy ?? "pairing";
    if (dmPolicy === "disabled") {
      return { allowed: false };
    }
    if (dmPolicy === "open") {
      return { allowed: true, commandAuthorized: true };
    }
    const storeAllowFrom = await readChannelAllowFromStore(
      "discord",
      process.env,
      params.accountId,
    ).catch(() => []);
    const configuredAllowFrom = discordCfg.allowFrom ?? discordCfg.dm?.allowFrom ?? [];
    const allowList = normalizeDiscordAllowList(
      [...configuredAllowFrom.map(String), ...storeAllowFrom],
      ["discord:", "user:", "pk:"],
    );
    if (!allowList) {
      return { allowed: true, commandAuthorized: true };
    }
    const allowed = allowListMatches(allowList, {
      id: sender.senderId ?? "",
      name: sender.senderName,
      tag: sender.senderTag,
    });
    if (!allowed) {
      return { allowed: false };
    }
    return { allowed: true, commandAuthorized: true };
  }

  const guildId = readMuxNonEmptyString(params.channelData?.guildId);
  const channelId = readMuxNonEmptyString(params.channelData?.channelId);
  if (!guildId || !channelId) {
    return { allowed: false };
  }
  const guildInfo = resolveDiscordGuildInfo({ cfg: params.cfg, guildId });
  const routeKey = readMuxNonEmptyString(params.channelData?.routeKey);
  const parentChannelId = parseDiscordParentChannelIdFromRouteKey(routeKey);
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId,
    channelSlug: "",
    ...(parentChannelId ? { parentId: parentChannelId, scope: "thread" as const } : {}),
  });

  const channelAllowlistConfigured =
    Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = channelConfig?.allowed !== false;
  if (
    !isDiscordGroupAllowedByPolicy({
      groupPolicy: discordCfg.groupPolicy ?? params.cfg.channels?.defaults?.groupPolicy ?? "open",
      guildAllowlisted: true,
      channelAllowlistConfigured,
      channelAllowed,
    })
  ) {
    return { allowed: false };
  }
  if (channelConfig?.enabled === false || channelConfig?.allowed === false) {
    return { allowed: false };
  }

  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds: sender.memberRoleIds,
    sender: {
      id: sender.senderId ?? "",
      name: sender.senderName,
      tag: sender.senderTag,
    },
  });
  if (hasAccessRestrictions && !memberAllowed) {
    return { allowed: false };
  }

  const pairedSenders = await readMuxPairedSenders({
    channel: "discord",
    accountId: params.accountId,
    routeKey: routeKey ?? `discord:default:guild:${guildId}`,
  }).catch(() => []);
  const configuredOwnerAllow = discordCfg.allowFrom?.map(String) ?? discordCfg.dm?.allowFrom ?? [];
  const ownerAllow =
    configuredOwnerAllow.length > 0
      ? configuredOwnerAllow.map(String)
      : hasControlCommandInMessage
        ? [...configuredOwnerAllow.map(String), ...pairedSenders]
        : [];
  const ownerAllowList = normalizeDiscordAllowList(ownerAllow, ["discord:", "user:", "pk:"]);
  const ownerOk = ownerAllowList
    ? allowListMatches(ownerAllowList, {
        id: sender.senderId ?? "",
        name: sender.senderName,
        tag: sender.senderTag,
      })
    : false;
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      { configured: ownerAllowList != null, allowed: ownerOk },
      { configured: hasAccessRestrictions, allowed: memberAllowed },
    ],
    modeWhenAccessGroupsOff: "configured",
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
  });
  if (commandGate.shouldBlock) {
    return { allowed: false };
  }

  const requireMention = resolveDiscordShouldRequireMention({
    isGuildMessage: true,
    isThread: parentChannelId != null,
    channelConfig,
    guildInfo,
  });
  const mentionGate = resolveMentionGatingWithBypass({
    isGroup: true,
    requireMention,
    canDetectMention: true,
    wasMentioned: params.wasMentioned,
    hasAnyMention: params.wasMentioned,
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
    commandAuthorized: commandGate.commandAuthorized,
  });
  if (mentionGate.shouldSkip) {
    return { allowed: false };
  }
  return {
    allowed: true,
    commandAuthorized: commandGate.commandAuthorized,
    effectiveWasMentioned: mentionGate.effectiveWasMentioned,
  };
}

async function resolveWhatsAppMuxAccess(params: {
  cfg: OpenClawConfig;
  accountId: string;
  payload: MuxInboundPayload;
  channelData: Record<string, unknown> | undefined;
  chatType: string;
}): Promise<MuxAccessResult> {
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const peer = resolveWhatsAppInboundPeerId({ payload: params.payload });
  const senderId = normalizeWhatsAppTarget(readMuxNonEmptyString(params.payload.from) ?? "");
  const isGroup = !isDirectChat(params.chatType);

  if (!isGroup) {
    const dmPolicy = account.dmPolicy ?? "pairing";
    if (dmPolicy === "disabled") {
      return { allowed: false };
    }
    if (dmPolicy === "open") {
      return { allowed: true, commandAuthorized: true };
    }
    const storeAllowFrom = await readChannelAllowFromStore(
      "whatsapp",
      process.env,
      account.accountId,
    ).catch(() => []);
    const effectiveDmAllow = normalizeWhatsAppAllowList([
      ...(account.allowFrom ?? []),
      ...storeAllowFrom,
    ]);
    if (!effectiveDmAllow.hasEntries) {
      return { allowed: true, commandAuthorized: true };
    }
    if (!senderId) {
      return { allowed: false };
    }
    const senderAllowed =
      effectiveDmAllow.hasWildcard || effectiveDmAllow.entries.includes(senderId);
    if (!senderAllowed) {
      return { allowed: false };
    }
    return { allowed: true, commandAuthorized: true };
  }

  const groupPolicy = account.groupPolicy ?? params.cfg.channels?.defaults?.groupPolicy ?? "open";
  if (groupPolicy === "disabled") {
    return { allowed: false };
  }
  const configuredGroupAllowFrom =
    account.groupAllowFrom ??
    (account.allowFrom && account.allowFrom.length > 0 ? account.allowFrom : undefined);
  const routeKey =
    readMuxNonEmptyString(params.channelData?.routeKey) ??
    (peer ? `whatsapp:${account.accountId}:chat:${peer.id}` : undefined);
  const pairedSenders =
    routeKey == null
      ? []
      : await readMuxPairedSenders({
          channel: "whatsapp",
          accountId: account.accountId,
          routeKey,
        }).catch(() => []);
  const runtimePairedSenders =
    configuredGroupAllowFrom && configuredGroupAllowFrom.length > 0 ? [] : pairedSenders;
  const effectiveGroupAllow = normalizeWhatsAppAllowList([
    ...(configuredGroupAllowFrom ?? []),
    ...runtimePairedSenders,
  ]);
  const senderAllowed = Boolean(
    senderId && (effectiveGroupAllow.hasWildcard || effectiveGroupAllow.entries.includes(senderId)),
  );
  if (groupPolicy === "allowlist") {
    if (!effectiveGroupAllow.hasEntries || !senderAllowed) {
      return { allowed: false };
    }
  }

  if (!useAccessGroups) {
    return { allowed: true, commandAuthorized: true };
  }
  return {
    allowed: true,
    commandAuthorized: senderAllowed,
  };
}

function applyMuxAccessToContext(ctx: MsgContext, access: MuxAccessResult): boolean {
  if (!access.allowed) {
    return false;
  }
  ctx.CommandAuthorized = access.commandAuthorized;
  if (typeof access.effectiveWasMentioned === "boolean") {
    ctx.WasMentioned = access.effectiveWasMentioned;
  }
  return true;
}

async function sendTelegramEditViaMux(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  accountId?: string;
  to: string;
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
    to: params.to,
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
  const transportSessionKey = readMuxNonEmptyString(payload.sessionKey);
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
  if (!isMuxBusinessChannel(channel)) {
    sendJson(res, 400, { ok: false, error: "unsupported mux channel" });
    return true;
  }
  const originatingTo = resolveMuxInboundOriginatingTarget({
    channel,
    payload,
    channelData,
  });
  if (!transportSessionKey) {
    sendJson(res, 400, { ok: false, error: "sessionKey required" });
    return true;
  }
  if (!originatingTo) {
    sendJson(res, 400, { ok: false, error: "to required" });
    return true;
  }
  const accountId = resolveMuxBusinessAccountId({
    cfg,
    channel,
    accountId: readMuxNonEmptyString(payload.accountId),
  });
  const sessionKey = resolveMuxInboundBusinessSessionKey({
    cfg,
    channel,
    payload,
    channelData,
    accountId,
    fallbackSessionKey: transportSessionKey,
  });
  const callbackPayload =
    channel === "telegram"
      ? resolveTelegramCallbackPayload({ payload, channelData, accountId })
      : null;
  if (!rawMessage.trim() && attachments.length === 0 && !callbackPayload) {
    sendJson(res, 400, { ok: false, error: "body or attachment required" });
    return true;
  }

  let inboundBody = rawMessage;
  if (callbackPayload) {
    try {
      const callbackAction = await resolveTelegramCallbackAction({
        cfg,
        accountId,
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
          accountId,
          to: originatingTo,
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
  let telegramAccess:
    | { allowed: false }
    | { allowed: true; commandAuthorized: boolean; effectiveWasMentioned?: boolean }
    | null = null;
  const ctx: MsgContext = {
    Body: inboundBody,
    BodyForAgent: inboundBody,
    BodyForCommands: inboundBody,
    RawBody: inboundBody,
    CommandBody: inboundBody,
    SessionKey: sessionKey,
    From: readMuxNonEmptyString(payload.from),
    To: originatingTo,
    AccountId: accountId,
    MessageSid: messageId,
    Timestamp: readMuxOptionalNumber(payload.timestampMs),
    ChatType: resolveMuxChatType(readMuxNonEmptyString(payload.chatType)),
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
      await bootstrapMuxPairedSender({
        channel,
        accountId,
        payload,
        channelData,
        messageId,
        chatType: String(ctx.ChatType ?? "direct"),
      });

      if (channel === "telegram") {
        telegramAccess = await resolveTelegramMuxAccess({
          cfg,
          accountId,
          payload,
          channelData,
          body: inboundBody,
          chatType: String(ctx.ChatType ?? "direct"),
          messageId,
          wasMentioned: callbackPayload != null || payload.wasMentioned === true,
        });
        if (!applyMuxAccessToContext(ctx, telegramAccess)) {
          return;
        }
      } else if (channel === "discord") {
        const discordAccess = await resolveDiscordMuxAccess({
          cfg,
          accountId,
          payload,
          channelData,
          body: inboundBody,
          chatType: String(ctx.ChatType ?? "direct"),
          wasMentioned: payload.wasMentioned === true,
        });
        if (!applyMuxAccessToContext(ctx, discordAccess)) {
          return;
        }
      } else {
        const whatsappAccess = await resolveWhatsAppMuxAccess({
          cfg,
          accountId,
          payload,
          channelData,
          chatType: String(ctx.ChatType ?? "direct"),
        });
        if (!applyMuxAccessToContext(ctx, whatsappAccess)) {
          return;
        }
      }

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
                to: originatingTo,
                ...(ctx.MessageThreadId != null ? { threadId: ctx.MessageThreadId } : {}),
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
  const replyToMode = resolveReplyToMode(cfg, "telegram", ctx.AccountId, ctx.ChatType);
  const draftReplyToMessageId = replyToMode !== "off" ? readMuxPositiveInt(messageId) : undefined;
  const threadReplyParams = buildTelegramThreadReplyParams({
    messageThreadId,
    chatType: ctx.ChatType,
    replyToMessageId: draftReplyToMessageId,
  });

  const mux: MuxTransportOpts = { cfg, sessionKey, accountId: ctx.AccountId };

  // Mirror direct-path command menu interception (bot-native-commands.ts:510-540).
  // When a command has argsMenu: "auto" and no args are provided, send inline
  // keyboard buttons and return early — identical to what the grammY handler does.
  const body = (ctx.Body ?? "").trim();
  const commandMatch = body.match(/^\/([a-z0-9_]+)(?:@\S+)?\s*(.*)/i);
  if (commandMatch) {
    const [, commandName, rawArgs] = commandMatch;
    const commandDef =
      findCommandByNativeName(commandName, "telegram") ??
      resolveTextCommand(`/${commandName}`, cfg)?.command;
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
  //   • send() reuses canonical Telegram thread/reply param builder from send.ts
  //   • finalization editFn uses textMode: "html" (via editMessageTelegram)
  const streaming = createTelegramStreamingDispatch({
    transport: {
      send: async (text) => {
        const result = await sendViaMux({
          cfg,
          channel: "telegram",
          sessionKey,
          accountId: ctx.AccountId,
          to: originatingTo,
          raw: {
            telegram: {
              method: "sendMessage",
              body: {
                text,
                ...threadReplyParams,
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
          to: originatingTo,
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
  let deliveryAttempted = false;
  try {
    await dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        deliver: async (payload, info) => {
          deliveryAttempted = true;
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
    // When no final payloads were delivered (e.g. blanket suppression after a
    // messaging-tool send) but the draft stream already has a preview message,
    // keep the streamed content instead of deleting it.
    if (!deliveryAttempted && streaming.draftStream.messageId() != null) {
      await streaming.draftStream.stop();
    } else {
      await streaming.cleanup();
    }
  }
}
