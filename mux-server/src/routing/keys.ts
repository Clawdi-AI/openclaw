import type {
  DiscordBoundRoute,
  DiscordOutboundTarget,
  IMessageBoundRoute,
  OutboundResolutionMode,
  WhatsAppBoundRoute,
  TelegramBoundRoute,
} from "../domain/types.js";
import { readNonEmptyString, readPositiveInt, readSignedNumericString } from "../domain/values.js";

export function parseTelegramRouteKey(routeKey: string): TelegramBoundRoute | null {
  const match = routeKey.match(/^telegram:[^:]+:chat:([^:]+)(?::topic:([^:]+))?$/);
  if (!match) {
    return null;
  }
  const chatId = match[1]?.trim();
  if (!chatId) {
    return null;
  }
  const topicId = readPositiveInt(match[2]);
  return topicId ? { chatId, topicId } : { chatId };
}

export function buildTelegramRouteKey(chatId: string, topicId?: number): string {
  if (topicId) {
    return `telegram:default:chat:${chatId}:topic:${topicId}`;
  }
  return `telegram:default:chat:${chatId}`;
}

export function deriveTelegramSessionKey(chatId: string, topicId?: number): string {
  const isGroup = chatId.startsWith("-");
  const base = isGroup
    ? `agent:main:telegram:group:${chatId}`
    : `agent:main:telegram:direct:${chatId}`;
  if (!topicId) {
    return base;
  }
  return isGroup ? `${base}:topic:${topicId}` : `${base}:thread:${topicId}`;
}

export function parseDiscordRouteKey(routeKey: string): DiscordBoundRoute | null {
  const dmMatch = routeKey.match(/^discord:[^:]+:dm:user:(\d+)$/);
  if (dmMatch?.[1]) {
    return { kind: "dm", userId: dmMatch[1] };
  }
  const guildMatch = routeKey.match(
    /^discord:[^:]+:guild:(\d+)(?::channel:(\d+))?(?::thread:(\d+))?$/,
  );
  if (!guildMatch?.[1]) {
    return null;
  }
  const guildId = guildMatch[1];
  const channelId = guildMatch[2];
  const threadId = guildMatch[3];
  return {
    kind: "guild",
    guildId,
    ...(channelId ? { channelId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export function buildDiscordGuildRouteKey(params: {
  guildId: string;
  channelId?: string;
  threadId?: string;
}): string {
  const base = `discord:default:guild:${params.guildId}`;
  if (params.channelId && params.threadId) {
    return `${base}:channel:${params.channelId}:thread:${params.threadId}`;
  }
  if (params.threadId) {
    return `${base}:thread:${params.threadId}`;
  }
  if (params.channelId) {
    return `${base}:channel:${params.channelId}`;
  }
  return base;
}

export function buildDiscordDmRouteKey(userId: string): string {
  return `discord:default:dm:user:${userId}`;
}

export function buildDiscordRouteKey(route: DiscordBoundRoute): string {
  if (route.kind === "dm") {
    return buildDiscordDmRouteKey(route.userId);
  }
  return buildDiscordGuildRouteKey({
    guildId: route.guildId,
    ...(route.channelId ? { channelId: route.channelId } : {}),
    ...(route.threadId ? { threadId: route.threadId } : {}),
  });
}

export function normalizeDiscordSessionAgentId(agentId: string | null | undefined): string {
  const trimmed = readNonEmptyString(agentId);
  return trimmed ? trimmed.toLowerCase() : "main";
}

export function resolveDiscordSessionAgentIdFromKey(sessionKey: string | null | undefined): string {
  const trimmed = readNonEmptyString(sessionKey);
  if (!trimmed) {
    return "main";
  }
  const match = trimmed.match(/^agent:([^:]+):/i);
  return normalizeDiscordSessionAgentId(match?.[1] ?? null);
}

export function buildDiscordDirectSessionKey(userId: string, agentId = "main"): string {
  return `agent:${normalizeDiscordSessionAgentId(agentId)}:discord:direct:${userId}`;
}

export function buildDiscordChannelSessionKey(channelId: string, agentId = "main"): string {
  return `agent:${normalizeDiscordSessionAgentId(agentId)}:discord:channel:${channelId}`;
}

export function buildDiscordThreadScopedSessionKey(
  baseSessionKey: string,
  threadId: string,
): string {
  return buildDiscordChannelSessionKey(
    threadId,
    resolveDiscordSessionAgentIdFromKey(baseSessionKey),
  );
}

export function resolveDiscordBindingRouteKeyForClaim(params: {
  incomingRoute: DiscordBoundRoute;
}): string {
  if (params.incomingRoute.kind === "guild") {
    return buildDiscordGuildRouteKey({
      guildId: params.incomingRoute.guildId,
    });
  }
  return buildDiscordRouteKey(params.incomingRoute);
}

export function resolveDiscordBindingScope(route: DiscordBoundRoute): string {
  if (route.kind === "dm") {
    return "dm";
  }
  if (route.threadId) {
    return "thread";
  }
  if (route.channelId) {
    return "channel";
  }
  return "guild";
}

export function buildWhatsAppRouteKey(chatJid: string, accountId = "default"): string {
  return `whatsapp:${accountId}:chat:${chatJid}`;
}

export function parseWhatsAppRouteKey(routeKey: string): WhatsAppBoundRoute | null {
  const match = routeKey.match(/^whatsapp:([^:]+):chat:(.+)$/);
  if (!match?.[1] || !match?.[2]) {
    return null;
  }
  const accountId = match[1].trim();
  const chatJid = match[2].trim();
  if (!accountId || !chatJid) {
    return null;
  }
  return { accountId, chatJid };
}

export function normalizeWhatsAppDirectPeerId(value: string | undefined): string | null {
  const raw = readNonEmptyString(value);
  if (!raw) {
    return null;
  }
  const withoutPrefix = raw.replace(/^whatsapp:/i, "").trim();

  const jidMatch = withoutPrefix.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/i);
  if (jidMatch?.[1]) {
    return `+${jidMatch[1]}`;
  }

  const lidMatch = withoutPrefix.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/i);
  if (lidMatch) {
    return null;
  }

  const digits = withoutPrefix.replace(/[^\d+]/g, "");
  if (!digits) {
    return null;
  }
  const normalized = digits.startsWith("+") ? `+${digits.slice(1)}` : `+${digits}`;
  return normalized.length > 1 ? normalized : null;
}

export function deriveWhatsAppSessionKey(params: {
  chatJid: string;
  chatType: "direct" | "group";
  directPeerId?: string;
}): string {
  if (params.chatType === "group") {
    return `agent:main:whatsapp:group:${params.chatJid}`;
  }
  const peerId =
    normalizeWhatsAppDirectPeerId(params.directPeerId) ??
    normalizeWhatsAppDirectPeerId(params.chatJid) ??
    readNonEmptyString(params.directPeerId) ??
    params.chatJid;
  return `agent:main:whatsapp:direct:${peerId}`;
}

export function parseDiscordOutboundTarget(value: unknown): DiscordOutboundTarget | null {
  const raw = readNonEmptyString(value);
  if (!raw) {
    return null;
  }
  const directChannel = raw.match(/^channel:(\d+)$/i);
  if (directChannel?.[1]) {
    return { kind: "channel", id: directChannel[1] };
  }
  const directUser = raw.match(/^user:(\d+)$/i);
  if (directUser?.[1]) {
    return { kind: "user", id: directUser[1] };
  }
  const discordChannel = raw.match(/^discord:channel:(\d+)$/i);
  if (discordChannel?.[1]) {
    return { kind: "channel", id: discordChannel[1] };
  }
  const discordUser = raw.match(/^discord:user:(\d+)$/i);
  if (discordUser?.[1]) {
    return { kind: "user", id: discordUser[1] };
  }
  const discordLegacy = raw.match(/^discord:(\d+)$/i);
  if (discordLegacy?.[1]) {
    return { kind: "user", id: discordLegacy[1] };
  }
  const userMention = raw.match(/^<@!?(\d+)>$/);
  if (userMention?.[1]) {
    return { kind: "user", id: userMention[1] };
  }
  const channelMention = raw.match(/^<#(\d+)>$/);
  if (channelMention?.[1]) {
    return { kind: "channel", id: channelMention[1] };
  }
  if (/^\d+$/.test(raw)) {
    return { kind: "channel", id: raw };
  }
  return null;
}

export function uniqueRouteKeys(routeKeys: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const routeKey of routeKeys) {
    const trimmed = readNonEmptyString(routeKey);
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

export function resolveOutboundResolutionMode(value: unknown): OutboundResolutionMode {
  const normalized = readNonEmptyString(value)?.toLowerCase();
  return normalized === "target-first" ? "target-first" : "session-first";
}

export function parseTelegramOutboundChatId(value: unknown): string | null {
  const direct = readSignedNumericString(value);
  if (direct) {
    return direct;
  }
  const prefixed = readNonEmptyString(value)?.match(/^(?:telegram|tg):(-?\d+)$/i);
  return prefixed?.[1] ?? null;
}

export function listTelegramOutboundRouteKeys(params: {
  requestedTo?: unknown;
  rawBody?: Record<string, unknown>;
  requestedThreadId?: number;
}): string[] {
  const rawChatId = parseTelegramOutboundChatId(params.rawBody?.chat_id);
  const requestedChatId = parseTelegramOutboundChatId(params.requestedTo);
  if (rawChatId && requestedChatId && rawChatId !== requestedChatId) {
    return [];
  }
  const rawThreadId = readPositiveInt(params.rawBody?.message_thread_id);
  if (rawThreadId && params.requestedThreadId && rawThreadId !== params.requestedThreadId) {
    return [];
  }
  const chatId = rawChatId ?? requestedChatId;
  if (!chatId) {
    return [];
  }
  const topicId = rawThreadId ?? params.requestedThreadId ?? undefined;
  return uniqueRouteKeys([
    topicId ? buildTelegramRouteKey(chatId, topicId) : null,
    buildTelegramRouteKey(chatId),
  ]);
}

export function parseWhatsAppOutboundChatJid(value: unknown): string | null {
  const raw = readNonEmptyString(value);
  if (!raw) {
    return null;
  }
  const withoutPrefix = raw.replace(/^whatsapp:/i, "").trim();
  if (withoutPrefix.includes("@")) {
    return withoutPrefix;
  }
  const digits = withoutPrefix.replace(/[^\d]/g, "");
  if (!digits) {
    return null;
  }
  return `${digits}@s.whatsapp.net`;
}

export function listWhatsAppOutboundRouteKeys(params: {
  requestedTo?: unknown;
  accountIds: Array<string | null | undefined>;
  rawSend?: Record<string, unknown> | null;
}): string[] {
  const outerChatJid = parseWhatsAppOutboundChatJid(params.requestedTo);
  const innerChatJid =
    parseWhatsAppOutboundChatJid(params.rawSend?.to) ??
    parseWhatsAppOutboundChatJid(params.rawSend?.chatJid);
  if (outerChatJid && innerChatJid && outerChatJid !== innerChatJid) {
    return [];
  }
  const chatJid = outerChatJid;
  if (!chatJid) {
    return [];
  }
  return uniqueRouteKeys(params.accountIds).map((accountId) =>
    buildWhatsAppRouteKey(chatJid, accountId),
  );
}

export function buildIMessageRouteKey(params: {
  chatGuid: string;
  chatType: "direct" | "group";
}): string {
  return `imessage:${params.chatType}:${params.chatGuid}`;
}

export function parseIMessageRouteKey(routeKey: string): IMessageBoundRoute | null {
  const match = routeKey.match(/^imessage:(direct|group):(.+)$/);
  if (!match?.[1] || !match?.[2]) {
    return null;
  }
  const chatType = match[1] === "group" ? "group" : "direct";
  const chatGuid = match[2].trim();
  return chatGuid ? { chatGuid, chatType } : null;
}

export function deriveIMessageSessionKey(params: {
  chatGuid: string;
  chatType: "direct" | "group";
}): string {
  return params.chatType === "group"
    ? `agent:main:imessage:group:${params.chatGuid}`
    : `agent:main:imessage:direct:${params.chatGuid}`;
}

export function parseIMessageOutboundChatGuid(value: unknown): string | null {
  const raw = readNonEmptyString(value);
  if (!raw) {
    return null;
  }
  return raw.replace(/^imessage:/i, "").trim() || null;
}

export function listIMessageOutboundRouteKeys(params: {
  requestedTo?: unknown;
  rawSend?: Record<string, unknown> | null;
}): string[] {
  const outerGuid = parseIMessageOutboundChatGuid(params.requestedTo);
  const innerGuid =
    parseIMessageOutboundChatGuid(params.rawSend?.to) ??
    parseIMessageOutboundChatGuid(params.rawSend?.chatGuid);
  if (outerGuid && innerGuid && outerGuid !== innerGuid) {
    return [];
  }
  const chatGuid = outerGuid ?? innerGuid;
  if (!chatGuid) {
    return [];
  }
  // Bindings created via pairing store the full BlueBubbles chat_guid. The
  // service prefix BlueBubbles emits depends on how the message arrived:
  //   - "any;-;+...": service-agnostic DM (most common in the Photon setup)
  //   - "iMessage;-;+...": explicit iMessage delivery
  //   - "SMS;-;+...": fallback SMS delivery (green bubble)
  // Agents normalize outbound targets to the bare handle
  // ("imessage:+15551234567" → "+15551234567"), so target-first lookup
  // would miss the binding without a fallback synthesis. Groups stay on
  // their full ";+;" chat_guid (creator-supplied and canonical).
  //
  // Multi-tenant safety: `resolveRouteKeyByTarget` filters by tenantId +
  // exact route_key, so the synthesized fallback keys can only match a
  // binding owned by the same tenant issuing the outbound — no cross-tenant
  // collision risk even when the same phone number is paired in two tenants.
  const isGroupChatGuid = chatGuid.includes(";+;");
  const isAlreadyChatGuid = isGroupChatGuid || chatGuid.includes(";-;");
  const chatType: "direct" | "group" = isGroupChatGuid ? "group" : "direct";
  const fallbackPrefixes =
    !isAlreadyChatGuid && chatType === "direct"
      ? (["any", "iMessage", "SMS"] as const)
      : ([] as const);
  return uniqueRouteKeys([
    buildIMessageRouteKey({ chatGuid, chatType }),
    ...fallbackPrefixes.map((prefix) =>
      buildIMessageRouteKey({ chatGuid: `${prefix};-;${chatGuid}`, chatType: "direct" }),
    ),
  ]);
}
