import WebSocket from "ws";
import type { DiscordBoundRoute, LiveBindingLookupRow } from "../../domain/types.js";
import {
  asRecord,
  normalizeControlText,
  readNonEmptyString,
  readPositiveInt,
  readUnsignedNumericString,
} from "../../domain/values.js";
import type { MuxInboundAttachment } from "../../mux-envelope.js";
import { buildDiscordDmRouteKey, buildDiscordGuildRouteKey } from "../../routing/keys.js";
import { inferMimeTypeFromPath } from "../telegram/media.js";

type DiscordInboundAttachment = MuxInboundAttachment;

type DiscordInboundMediaSummary = {
  id?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  url?: string;
};

export function createDiscordApiService(deps: {
  discordApiBaseUrl: string;
  requireDiscordBotToken: () => string;
  resolveLiveBindingByRouteKey: (channel: string, routeKey: string) => LiveBindingLookupRow | null;
}) {
  const discordChannelInfoCache = new Map<
    string,
    {
      guildId: string | null;
      parentId: string | null;
      channelType: number | null;
      expiresAtMs: number;
    }
  >();
  const discordChannelGuildCacheTtlMs = 30_000;
  const discordDmChannelCache = new Map<string, { channelId: string; expiresAtMs: number }>();
  const discordDmChannelCacheTtlMs = 10 * 60_000;

  function parseDiscordJsonBody(text: string): Record<string, unknown> {
    const trimmed = text.trim();
    if (!trimmed) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return { raw: trimmed };
    }
  }

  async function discordRequest(params: {
    method: "GET" | "POST";
    path: string;
    body?: Record<string, unknown>;
  }): Promise<{ response: Response; result: Record<string, unknown> }> {
    const token = deps.requireDiscordBotToken();
    const response = await fetch(`${deps.discordApiBaseUrl}${params.path}`, {
      method: params.method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      ...(params.body ? { body: JSON.stringify(params.body) } : {}),
    });
    const result = parseDiscordJsonBody(await response.text());
    return { response, result };
  }

  function parseDiscordGatewayPayload(raw: WebSocket.RawData): Record<string, unknown> | null {
    let text: string | null = null;
    if (typeof raw === "string") {
      text = raw;
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString("utf8");
    } else if (Array.isArray(raw)) {
      text = Buffer.concat(raw).toString("utf8");
    } else if (raw instanceof ArrayBuffer) {
      text = Buffer.from(raw).toString("utf8");
    }
    if (!text) {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      return asRecord(parsed);
    } catch {
      return null;
    }
  }

  async function fetchDiscordGatewayUrl(): Promise<string> {
    const { response, result } = await discordRequest({
      method: "GET",
      path: "/gateway/bot",
    });
    if (!response.ok) {
      throw new Error(`discord gateway discovery failed (${response.status})`);
    }
    const rawUrl = readNonEmptyString(result.url) ?? "wss://gateway.discord.gg";
    const base = rawUrl.replace(/\/+$/, "");
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}v=10&encoding=json`;
  }

  async function resolveDiscordDmChannelId(userId: string): Promise<string> {
    const { response, result } = await discordRequest({
      method: "POST",
      path: "/users/@me/channels",
      body: { recipient_id: userId },
    });
    if (!response.ok) {
      throw new Error(`discord create dm failed (${response.status})`);
    }
    const channelId = readUnsignedNumericString(result.id);
    if (!channelId) {
      throw new Error("discord create dm returned invalid channel id");
    }
    return channelId;
  }

  async function resolveDiscordDmChannelIdCached(userId: string): Promise<string> {
    const now = Date.now();
    const cached = discordDmChannelCache.get(userId);
    if (cached && cached.expiresAtMs > now) {
      return cached.channelId;
    }
    const channelId = await resolveDiscordDmChannelId(userId);
    discordDmChannelCache.set(userId, {
      channelId,
      expiresAtMs: now + discordDmChannelCacheTtlMs,
    });
    return channelId;
  }

  async function resolveDiscordChannelInfo(channelId: string): Promise<{
    guildId: string | null;
    parentId: string | null;
    channelType: number | null;
  }> {
    const now = Date.now();
    const cached = discordChannelInfoCache.get(channelId);
    if (cached && cached.expiresAtMs > now) {
      return {
        guildId: cached.guildId,
        parentId: cached.parentId,
        channelType: cached.channelType,
      };
    }
    const { response, result } = await discordRequest({
      method: "GET",
      path: `/channels/${channelId}`,
    });
    if (!response.ok) {
      throw new Error(`discord channel lookup failed (${response.status})`);
    }
    const guildId = readUnsignedNumericString(result.guild_id) ?? null;
    const parentId = readUnsignedNumericString(result.parent_id) ?? null;
    const channelType =
      typeof result.type === "number" && Number.isFinite(result.type)
        ? Math.trunc(result.type)
        : null;
    discordChannelInfoCache.set(channelId, {
      guildId,
      parentId,
      channelType,
      expiresAtMs: now + discordChannelGuildCacheTtlMs,
    });
    return { guildId, parentId, channelType };
  }

  async function resolveDiscordChannelGuildId(channelId: string): Promise<string | null> {
    const info = await resolveDiscordChannelInfo(channelId);
    return info.guildId;
  }

  async function resolveDiscordIncomingRouteFromMessage(params: {
    message: Record<string, unknown>;
    fromId: string;
    fallbackRoute?: DiscordBoundRoute;
    fallbackChannelId?: string;
  }): Promise<{ route: DiscordBoundRoute; channelId: string } | null> {
    const channelId =
      readUnsignedNumericString(params.message.channel_id) ??
      readUnsignedNumericString(params.fallbackChannelId);
    if (!channelId) {
      return null;
    }
    const guildId = readUnsignedNumericString(params.message.guild_id);
    if (!guildId) {
      return {
        route: { kind: "dm", userId: params.fromId },
        channelId,
      };
    }

    if (
      params.fallbackRoute?.kind === "guild" &&
      params.fallbackRoute.threadId &&
      params.fallbackRoute.threadId === channelId
    ) {
      return {
        route: params.fallbackRoute,
        channelId,
      };
    }

    const rawThread = asRecord(params.message.thread);
    const threadIdFromPayload = readUnsignedNumericString(rawThread?.id);
    const threadParentIdFromPayload = readUnsignedNumericString(rawThread?.parent_id);
    if (threadIdFromPayload && threadIdFromPayload === channelId) {
      return {
        route: {
          kind: "guild",
          guildId,
          ...(threadParentIdFromPayload ? { channelId: threadParentIdFromPayload } : {}),
          threadId: threadIdFromPayload,
        },
        channelId,
      };
    }

    const channelInfo = await resolveDiscordChannelInfo(channelId);
    if (channelInfo.parentId) {
      return {
        route: {
          kind: "guild",
          guildId,
          channelId: channelInfo.parentId,
          threadId: channelId,
        },
        channelId,
      };
    }

    return {
      route: {
        kind: "guild",
        guildId,
        channelId,
      },
      channelId,
    };
  }

  function listDiscordRouteLookupKeys(route: DiscordBoundRoute): string[] {
    const keys: string[] = [];
    if (route.kind === "dm") {
      keys.push(buildDiscordDmRouteKey(route.userId));
      return keys;
    }
    if (route.threadId) {
      keys.push(
        buildDiscordGuildRouteKey({
          guildId: route.guildId,
          ...(route.channelId ? { channelId: route.channelId } : {}),
          threadId: route.threadId,
        }),
      );
      keys.push(
        buildDiscordGuildRouteKey({
          guildId: route.guildId,
          threadId: route.threadId,
        }),
      );
    }
    if (route.channelId) {
      keys.push(
        buildDiscordGuildRouteKey({
          guildId: route.guildId,
          channelId: route.channelId,
        }),
      );
    }
    keys.push(buildDiscordGuildRouteKey({ guildId: route.guildId }));
    return [...new Set(keys)];
  }

  function resolveDiscordBindingForIncoming(route: DiscordBoundRoute): {
    tenantId: string;
    bindingId: string;
    status: "active" | "pending";
    routeKey: string;
  } | null {
    const routeKeys = listDiscordRouteLookupKeys(route);
    for (const routeKey of routeKeys) {
      const row = deps.resolveLiveBindingByRouteKey("discord", routeKey);
      if (!row) {
        continue;
      }
      return {
        tenantId: row.tenant_id,
        bindingId: row.binding_id,
        status: row.status === "pending" ? "pending" : "active",
        routeKey,
      };
    }
    return null;
  }

  async function sendDiscordTyping(params: {
    channelId: string;
  }): Promise<{ response: Response; result: Record<string, unknown> }> {
    return await discordRequest({
      method: "POST",
      path: `/channels/${params.channelId}/typing`,
    });
  }

  function parseSnowflake(value: unknown): bigint | null {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      try {
        return BigInt(Math.trunc(value));
      } catch {
        return null;
      }
    }
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return null;
    }
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }

  function sortDiscordMessagesAsc(messages: Record<string, unknown>[]): Record<string, unknown>[] {
    return messages.toSorted((a, b) => {
      const aId = parseSnowflake(a.id);
      const bId = parseSnowflake(b.id);
      if (aId === null && bId === null) {
        return 0;
      }
      if (aId === null) {
        return -1;
      }
      if (bId === null) {
        return 1;
      }
      if (aId < bId) {
        return -1;
      }
      if (aId > bId) {
        return 1;
      }
      return 0;
    });
  }

  function listDiscordAttachmentCandidates(attachments: unknown): Array<{
    id?: string;
    fileName?: string;
    mimeType?: string;
    url?: string;
    size?: number;
  }> {
    if (!Array.isArray(attachments)) {
      return [];
    }
    return attachments
      .map((item) => {
        const entry = item as Record<string, unknown>;
        return {
          id: readUnsignedNumericString(entry.id),
          fileName: readNonEmptyString(entry.filename) ?? undefined,
          mimeType: readNonEmptyString(entry.content_type)?.toLowerCase() ?? undefined,
          url: readNonEmptyString(entry.url) ?? undefined,
          size: readPositiveInt(entry.size),
        };
      })
      .filter((entry) => Boolean(entry.url));
  }

  async function extractDiscordInboundMedia(params: {
    message: Record<string, unknown>;
    messageId: string;
  }): Promise<{
    attachments: DiscordInboundAttachment[];
    media: DiscordInboundMediaSummary[];
  }> {
    const summaries: DiscordInboundMediaSummary[] = [];
    const attachments: DiscordInboundAttachment[] = [];
    for (const item of listDiscordAttachmentCandidates(params.message.attachments)) {
      summaries.push({
        id: item.id,
        fileName: item.fileName,
        mimeType: item.mimeType,
        size: item.size,
        url: item.url,
      });
      if (!item.url) {
        continue;
      }
      const resolvedMime =
        item.mimeType ||
        inferMimeTypeFromPath(item.fileName ?? item.url) ||
        "application/octet-stream";
      attachments.push({
        type: resolvedMime.split("/")[0] || "file",
        mimeType: resolvedMime,
        fileName: item.fileName || item.id || `discord-${params.messageId}`,
        url: item.url,
      });
    }
    return { attachments, media: summaries };
  }

  function isDiscordCommandText(input: string): boolean {
    const normalized = normalizeControlText(input);
    if (!normalized) {
      return false;
    }
    return /^\/[A-Za-z0-9_]+/.test(normalized);
  }

  function hasDiscordMessageContent(message: Record<string, unknown>): boolean {
    const text = typeof message.content === "string" ? message.content : null;
    if (normalizeControlText(text)) {
      return true;
    }
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    if (attachments.some((attachment) => Boolean(attachment && typeof attachment === "object"))) {
      return true;
    }
    const snapshots = Array.isArray(message.message_snapshots) ? message.message_snapshots : [];
    return snapshots.length > 0;
  }

  async function sendDiscordPairingNotice(params: { channelId: string; text: string }) {
    const { response } = await discordRequest({
      method: "POST",
      path: `/channels/${params.channelId}/messages`,
      body: {
        content: params.text,
      },
    });
    if (!response.ok) {
      throw new Error(`discord pairing notice failed (${response.status})`);
    }
  }

  return {
    discordRequest,
    parseDiscordGatewayPayload,
    fetchDiscordGatewayUrl,
    resolveDiscordDmChannelId,
    resolveDiscordDmChannelIdCached,
    resolveDiscordChannelInfo,
    resolveDiscordChannelGuildId,
    resolveDiscordIncomingRouteFromMessage,
    listDiscordRouteLookupKeys,
    resolveDiscordBindingForIncoming,
    sendDiscordTyping,
    parseSnowflake,
    sortDiscordMessagesAsc,
    extractDiscordInboundMedia,
    isDiscordCommandText,
    hasDiscordMessageContent,
    sendDiscordPairingNotice,
  };
}
