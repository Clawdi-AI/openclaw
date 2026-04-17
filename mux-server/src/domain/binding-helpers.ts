import { hashApiKey } from "../auth/service.js";
import type { MuxConfig } from "../config/env.js";
import type { PreparedStatements } from "../db/statements.js";
import {
  buildTelegramRouteKey,
  buildWhatsAppRouteKey,
  parseDiscordOutboundTarget,
  parseDiscordRouteKey,
  parseIMessageRouteKey,
  parseTelegramRouteKey,
  parseWhatsAppRouteKey,
} from "../routing/keys.js";
import { createDiscordForwardingService } from "./discord-forwarding.js";
import { createPostPairingDeliveryService } from "./post-pairing-delivery.js";
import type {
  ActiveBindingLookupRow,
  DiscordBoundRoute,
  IMessageBoundRoute,
  NoticeChannel,
  OutboundResolutionMode,
  ResolvedBoundRoute,
  StyledNotice,
  TelegramBoundRoute,
  TenantInboundTarget,
  WhatsAppBoundRoute,
} from "./types.js";
import {
  normalizeControlText,
  readNonEmptyString,
  readPositiveInt,
  readUnsignedNumericString,
} from "./values.js";

type WebInboundMessage = {
  id?: string;
  from: string;
  to: string;
  accountId: string;
  body: string;
  timestamp?: number;
  chatType: "direct" | "group";
  chatId: string;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderJid?: string;
  replyToSenderE164?: string;
  groupSubject?: string;
  groupParticipants?: string[];
  mentionedJids?: string[];
  mediaPath?: string;
  mediaType?: string;
  mediaUrl?: string;
};

type MuxInboundAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: string;
  url?: string;
};

type InboundMediaSummary = {
  id?: string;
  fileName?: string;
  mimeType?: string;
  url?: string;
  size?: number;
};

export function createBindingHelpers(deps: {
  db: Pick<
    PreparedStatements,
    | "stmtSelectActiveBindingByRouteKey"
    | "stmtDeactivateLiveBinding"
    | "stmtSetBindingPending"
    | "stmtDeleteSessionRoutesByBinding"
    | "stmtSelectSessionKeyByBinding"
    | "stmtUpsertSessionRoute"
    | "stmtUpsertTenantByRegister"
    | "stmtUpsertTenantInboundTargetByAdmin"
    | "stmtSelectTelegramOffset"
    | "stmtUpsertTelegramOffset"
    | "stmtSelectDiscordOffsetByBinding"
    | "stmtUpsertDiscordOffsetByBinding"
  >;

  config: Pick<
    MuxConfig,
    | "runtimeTokenTtlSec"
    | "runtimeJwtAudienceMux"
    | "runtimeJwtAudienceOpenClaw"
    | "inboundTokenTtlSec"
    | "telegramGeneralTopicId"
    | "openclawMuxAccountId"
  >;

  // Mutable state accessors
  getDiscordBotSelfId: () => string | null;
  getDiscordRuntimeHealth: () => { lastInboundSeenAtMs: number | null };

  // Service functions
  runtimeJwtSigner: {
    mint: (params: {
      subject: string;
      audiences: string[];
      scope: string;
      ttlSec: number;
      nowMs?: number;
    }) => Promise<string>;
  };
  resolveDiscordChannelInfo: (channelId: string) => Promise<{
    guildId: string | null;
    parentId: string | null;
    channelType: number | null;
  }>;
  resolveDiscordChannelGuildId: (channelId: string) => Promise<string | null>;
  resolveDiscordDmChannelId: (userId: string) => Promise<string>;
  resolveDiscordDmChannelIdCached: (userId: string) => Promise<string>;
  resolveDiscordInboundSessionKey: (params: {
    tenantId: string;
    bindingId: string;
    route: DiscordBoundRoute;
    channelId: string;
  }) => string;
  resolveSessionRouteBinding: (params: {
    tenantId: string;
    channel: "telegram" | "discord" | "whatsapp" | "imessage";
    sessionKey: string;
    routeKeys?: string[];
    mode?: OutboundResolutionMode;
  }) => { routeKey: string; via: "session" | "route" } | null;
  extractDiscordInboundMedia: (params: {
    message: Record<string, unknown>;
    messageId: string;
  }) => Promise<{
    attachments: MuxInboundAttachment[];
    media: InboundMediaSummary[];
  }>;
  resolveTenantInboundTarget: (tenantId: string) => TenantInboundTarget | null;
  resolvePostPairingPrompt: (channel: NoticeChannel) => string;
  metrics: {
    recordActiveUser: (
      channel: "telegram" | "discord" | "whatsapp",
      userId: unknown,
      nowMs?: number,
    ) => void;
    recordInboundEvent: (
      channel: "telegram" | "discord" | "whatsapp",
      outcome: "forwarded" | "deferred" | "dropped" | "error",
    ) => void;
    observeInboundForwardDuration: (
      channel: "telegram" | "discord" | "whatsapp",
      durationMs: number,
    ) => void;
  };
  renderPairingRepairedNotice: (channel: NoticeChannel) => StyledNotice;
  renderPairingTakeoverNotice: (channel: NoticeChannel) => StyledNotice;
  renderPairingSuccessNotice: (channel: NoticeChannel) => StyledNotice;
  renderWhatsAppContactTip: (channel: NoticeChannel) => StyledNotice;
  loadWebRuntimeModules: () => Promise<{
    sendMessageWhatsApp: (
      to: string,
      body: string,
      options: { verbose: boolean; accountId?: string },
    ) => Promise<{ messageId: string; toJid: string }>;
  }>;
  log: (entry: Record<string, unknown>) => void;
  writeAuditLog: (
    tenantId: string,
    eventType: string,
    payload: Record<string, unknown>,
    timestampMs?: number,
  ) => void;
}) {
  async function mintRuntimeJwt(params: {
    openclawId: string;
    scope: string;
    audiences: string[];
    ttlSec?: number;
    nowMs?: number;
  }): Promise<string> {
    return await deps.runtimeJwtSigner.mint({
      subject: params.openclawId,
      audiences: params.audiences,
      scope: params.scope,
      ttlSec: Math.max(1, Math.trunc(params.ttlSec ?? deps.config.runtimeTokenTtlSec)),
      nowMs: params.nowMs,
    });
  }

  async function buildInboundAuthHeaders(
    target: TenantInboundTarget,
    traceId?: string,
  ): Promise<Record<string, string>> {
    const runtimeJwt = await mintRuntimeJwt({
      openclawId: target.openclawId,
      scope: "mux:inbound",
      audiences: [deps.config.runtimeJwtAudienceOpenClaw],
      ttlSec: deps.config.inboundTokenTtlSec,
    });
    return {
      Authorization: `Bearer ${runtimeJwt}`,
      "X-OpenClaw-Id": target.openclawId,
      ...(typeof traceId === "string" && traceId.trim()
        ? { "X-Mux-Trace-Id": traceId.trim() }
        : {}),
    };
  }

  function isWhatsAppCommandText(input: string): boolean {
    const normalized = normalizeControlText(input);
    if (!normalized) {
      return false;
    }
    return /^[/!][A-Za-z0-9_]+/.test(normalized);
  }

  function hasWhatsAppMessageContent(message: WebInboundMessage): boolean {
    if (normalizeControlText(message.body)) {
      return true;
    }
    return Boolean(
      readNonEmptyString(message.mediaPath) ||
      readNonEmptyString(message.mediaType) ||
      readNonEmptyString(message.mediaUrl),
    );
  }

  async function sendWhatsAppPairingNotice(params: {
    chatJid: string;
    accountId: string;
    text: string;
  }) {
    const { sendMessageWhatsApp } = await deps.loadWebRuntimeModules();
    await sendMessageWhatsApp(params.chatJid, params.text, {
      verbose: false,
      accountId: params.accountId,
    });
  }

  async function resolveDiscordExplicitThreadParentId(
    threadId: string | undefined,
  ): Promise<string | undefined> {
    const normalizedThreadId = readUnsignedNumericString(threadId);
    if (!normalizedThreadId) {
      return undefined;
    }
    try {
      const info = await deps.resolveDiscordChannelInfo(normalizedThreadId);
      return info.parentId ?? undefined;
    } catch {
      return undefined;
    }
  }

  function resolveTelegramBoundRoute(params: {
    tenantId: string;
    channel: "telegram";
    sessionKey: string;
    routeKeys?: string[];
    mode?: OutboundResolutionMode;
  }): ResolvedBoundRoute<TelegramBoundRoute> | null {
    const resolved = deps.resolveSessionRouteBinding(params);
    if (!resolved) {
      return null;
    }
    const route = parseTelegramRouteKey(resolved.routeKey);
    return route ? { route, routeKey: resolved.routeKey, via: resolved.via } : null;
  }

  async function resolveDiscordBoundRoute(params: {
    tenantId: string;
    channel: "discord";
    sessionKey: string;
    routeKeys?: string[];
    mode?: OutboundResolutionMode;
  }): Promise<ResolvedBoundRoute<DiscordBoundRoute> | null> {
    const resolved = deps.resolveSessionRouteBinding(params);
    if (!resolved) {
      return null;
    }
    const route = parseDiscordRouteKey(resolved.routeKey);
    return route ? { route, routeKey: resolved.routeKey, via: resolved.via } : null;
  }

  function resolveWhatsAppBoundRoute(params: {
    tenantId: string;
    channel: "whatsapp";
    sessionKey: string;
    routeKeys?: string[];
    mode?: OutboundResolutionMode;
  }): ResolvedBoundRoute<WhatsAppBoundRoute> | null {
    const resolved = deps.resolveSessionRouteBinding(params);
    if (!resolved) {
      return null;
    }
    const route = parseWhatsAppRouteKey(resolved.routeKey);
    return route ? { route, routeKey: resolved.routeKey, via: resolved.via } : null;
  }

  function resolveIMessageBoundRoute(params: {
    tenantId: string;
    channel: "imessage";
    sessionKey: string;
    routeKeys?: string[];
    mode?: OutboundResolutionMode;
  }): ResolvedBoundRoute<IMessageBoundRoute> | null {
    const resolved = deps.resolveSessionRouteBinding(params);
    if (!resolved) {
      return null;
    }
    const route = parseIMessageRouteKey(resolved.routeKey);
    return route ? { route, routeKey: resolved.routeKey, via: resolved.via } : null;
  }

  function resolveIMessageBindingForIncoming(
    routeKey: string,
  ): { tenantId: string; bindingId: string; routeKey: string } | null {
    const row = deps.db.stmtSelectActiveBindingByRouteKey.get("imessage", routeKey) as
      | ActiveBindingLookupRow
      | undefined;
    if (!row?.tenant_id || !row?.binding_id) {
      return null;
    }
    return {
      tenantId: String(row.tenant_id),
      bindingId: String(row.binding_id),
      routeKey,
    };
  }

  async function resolveDiscordOutboundChannelId(params: {
    boundRoute: DiscordBoundRoute;
    requestedTo: unknown;
    requestedThreadId?: string;
  }): Promise<{ ok: true; channelId: string } | { ok: false; statusCode: number; error: string }> {
    if (params.boundRoute.kind === "dm") {
      const channelId = await deps.resolveDiscordDmChannelId(params.boundRoute.userId);
      return { ok: true, channelId };
    }

    let channelId =
      params.boundRoute.threadId ?? params.requestedThreadId ?? params.boundRoute.channelId;
    const explicitThreadParentId = await resolveDiscordExplicitThreadParentId(
      params.requestedThreadId,
    );
    if (
      params.boundRoute.channelId &&
      explicitThreadParentId &&
      explicitThreadParentId !== params.boundRoute.channelId
    ) {
      return {
        ok: false,
        statusCode: 403,
        error: "discord channel not allowed for this bound guild",
      };
    }
    if (!channelId) {
      const target = parseDiscordOutboundTarget(params.requestedTo);
      if (target?.kind === "user") {
        return {
          ok: false,
          statusCode: 403,
          error: "discord route is guild-bound and cannot target DMs",
        };
      }
      channelId = target?.id;
    }
    if (!channelId) {
      return {
        ok: false,
        statusCode: 400,
        error: "discord guild-bound route requires channel target (to or routeKey channel)",
      };
    }

    const guildId = await deps.resolveDiscordChannelGuildId(channelId);
    if (!guildId) {
      return {
        ok: false,
        statusCode: 403,
        error: "discord channel is not in a guild for guild-bound route",
      };
    }
    if (guildId !== params.boundRoute.guildId) {
      return {
        ok: false,
        statusCode: 403,
        error: "discord channel not allowed for this bound guild",
      };
    }
    return { ok: true, channelId };
  }

  function resolveTelegramIncomingTopicId(params: {
    isForum: boolean;
    messageThreadId: unknown;
  }): number | undefined {
    const explicitTopicId = readPositiveInt(params.messageThreadId);
    if (explicitTopicId) {
      return explicitTopicId;
    }
    return params.isForum ? deps.config.telegramGeneralTopicId : undefined;
  }

  function resolveTelegramBindingForIncoming(
    chatId: string,
    topicId?: number,
  ): { tenantId: string; bindingId: string; routeKey: string } | null {
    const topicRouteKey = topicId ? buildTelegramRouteKey(chatId, topicId) : null;
    if (topicRouteKey) {
      const topicRow = deps.db.stmtSelectActiveBindingByRouteKey.get("telegram", topicRouteKey) as
        | ActiveBindingLookupRow
        | undefined;
      if (topicRow?.tenant_id && topicRow?.binding_id) {
        return {
          tenantId: String(topicRow.tenant_id),
          bindingId: String(topicRow.binding_id),
          routeKey: topicRouteKey,
        };
      }
    }

    const chatRouteKey = buildTelegramRouteKey(chatId);
    const chatRow = deps.db.stmtSelectActiveBindingByRouteKey.get("telegram", chatRouteKey) as
      | ActiveBindingLookupRow
      | undefined;
    if (!chatRow?.tenant_id || !chatRow?.binding_id) {
      return null;
    }
    return {
      tenantId: String(chatRow.tenant_id),
      bindingId: String(chatRow.binding_id),
      routeKey: chatRouteKey,
    };
  }

  function resolveWhatsAppBindingForIncoming(params: {
    chatJid: string;
    accountId: string;
  }): { tenantId: string; bindingId: string; routeKey: string } | null {
    const routeKey = buildWhatsAppRouteKey(params.chatJid, params.accountId);
    const row = deps.db.stmtSelectActiveBindingByRouteKey.get("whatsapp", routeKey) as
      | ActiveBindingLookupRow
      | undefined;
    if (!row?.tenant_id || !row?.binding_id) {
      return null;
    }
    return {
      tenantId: String(row.tenant_id),
      bindingId: String(row.binding_id),
      routeKey,
    };
  }

  function deactivateLiveBinding(params: {
    tenantId: string;
    bindingId: string;
    auditEventType: string;
  }): boolean {
    const now = Date.now();
    const update = deps.db.stmtDeactivateLiveBinding.run(now, params.bindingId, params.tenantId);
    if (Number(update.changes) === 0) {
      return false;
    }
    deps.db.stmtDeleteSessionRoutesByBinding.run(params.bindingId, params.tenantId);
    deps.writeAuditLog(
      params.tenantId,
      params.auditEventType,
      { bindingId: params.bindingId },
      now,
    );
    return true;
  }

  function setBindingPending(params: {
    tenantId: string;
    bindingId: string;
    auditEventType: string;
  }): boolean {
    const now = Date.now();
    const update = deps.db.stmtSetBindingPending.run(now, params.bindingId, params.tenantId);
    if (Number(update.changes) === 0) {
      return false;
    }
    deps.db.stmtDeleteSessionRoutesByBinding.run(params.bindingId, params.tenantId);
    deps.writeAuditLog(
      params.tenantId,
      params.auditEventType,
      { bindingId: params.bindingId },
      now,
    );
    return true;
  }

  function resolveBindingSessionKey(params: {
    tenantId: string;
    channel: "telegram" | "discord" | "whatsapp";
    bindingId: string;
  }): string | null {
    const row = deps.db.stmtSelectSessionKeyByBinding.get(
      params.tenantId,
      params.channel,
      params.bindingId,
    ) as { session_key?: unknown } | undefined;
    return readNonEmptyString(row?.session_key);
  }

  async function registerOpenClawInstance(input: {
    openclawId?: unknown;
    inboundUrl?: unknown;
    inboundTimeoutMs?: unknown;
  }): Promise<{
    statusCode: number;
    payload: Record<string, unknown>;
  }> {
    const openclawId = readNonEmptyString(input.openclawId);
    const inboundUrl = readNonEmptyString(input.inboundUrl);
    if (!openclawId || !inboundUrl) {
      return {
        statusCode: 400,
        payload: { ok: false, error: "openclawId and inboundUrl are required" },
      };
    }
    const inboundTimeoutMs = readPositiveInt(input.inboundTimeoutMs) ?? 15_000;
    const now = Date.now();
    const syntheticApiKey = `instance:${openclawId}`;
    try {
      deps.db.stmtUpsertTenantByRegister.run(
        openclawId,
        openclawId,
        hashApiKey(syntheticApiKey),
        inboundUrl,
        inboundTimeoutMs,
        now,
        now,
      );
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: tenants.api_key_hash")) {
        return {
          statusCode: 409,
          payload: { ok: false, error: "instance id conflict" },
        };
      }
      throw error;
    }
    deps.writeAuditLog(openclawId, "instance_registered", { inboundUrl, inboundTimeoutMs }, now);
    const runtimeToken = await mintRuntimeJwt({
      openclawId,
      scope: "mux:runtime mux:outbound mux:pairings mux:control",
      audiences: [deps.config.runtimeJwtAudienceMux],
    });
    return {
      statusCode: 200,
      payload: {
        ok: true,
        openclawId,
        runtimeToken,
        tokenType: "Bearer",
        expiresAtMs: now + deps.config.runtimeTokenTtlSec * 1_000,
      },
    };
  }

  function upsertTenantInboundTargetByAdmin(params: {
    openclawId: string;
    inboundUrl: string;
    inboundTimeoutMs?: number;
  }): { ok: true } | { ok: false; statusCode: number; error: string } {
    const now = Date.now();
    const syntheticApiKey = `instance:${params.openclawId}`;
    try {
      deps.db.stmtUpsertTenantInboundTargetByAdmin.run(
        params.openclawId,
        params.openclawId,
        hashApiKey(syntheticApiKey),
        params.inboundUrl,
        params.inboundTimeoutMs ?? 15_000,
        now,
        now,
      );
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: tenants.api_key_hash")) {
        return {
          ok: false,
          statusCode: 409,
          error: "instance id conflict",
        };
      }
      throw error;
    }
    return { ok: true };
  }

  function resolveStoredTelegramOffset(): number {
    const row = deps.db.stmtSelectTelegramOffset.get() as { last_update_id?: unknown } | undefined;
    if (!row || typeof row.last_update_id !== "number" || !Number.isFinite(row.last_update_id)) {
      return 0;
    }
    return Math.trunc(row.last_update_id);
  }

  function storeTelegramOffset(lastUpdateId: number) {
    deps.db.stmtUpsertTelegramOffset.run(lastUpdateId, Date.now());
  }

  function resolveStoredDiscordOffset(bindingId: string): string | null {
    const row = deps.db.stmtSelectDiscordOffsetByBinding.get(bindingId) as
      | { last_message_id?: unknown }
      | undefined;
    const offset = readUnsignedNumericString(row?.last_message_id);
    return offset ?? null;
  }

  function storeDiscordOffset(bindingId: string, lastMessageId: string) {
    deps.db.stmtUpsertDiscordOffsetByBinding.run(bindingId, lastMessageId, Date.now());
  }

  async function resolveDiscordInboundChannelId(route: DiscordBoundRoute): Promise<string | null> {
    if (route.kind === "dm") {
      return await deps.resolveDiscordDmChannelIdCached(route.userId);
    }
    if (route.threadId) {
      return route.threadId;
    }
    if (route.channelId) {
      return route.channelId;
    }
    return null;
  }

  // Instantiate extracted service modules, passing buildInboundAuthHeaders as a dep
  const discordForwarding = createDiscordForwardingService({
    db: deps.db,
    config: deps.config,
    getDiscordBotSelfId: deps.getDiscordBotSelfId,
    getDiscordRuntimeHealth: deps.getDiscordRuntimeHealth,
    resolveDiscordInboundSessionKey: deps.resolveDiscordInboundSessionKey,
    extractDiscordInboundMedia: deps.extractDiscordInboundMedia,
    resolveTenantInboundTarget: deps.resolveTenantInboundTarget,
    metrics: deps.metrics,
    log: deps.log,
    buildInboundAuthHeaders,
  });

  const postPairingDelivery = createPostPairingDeliveryService({
    config: deps.config,
    resolveTenantInboundTarget: deps.resolveTenantInboundTarget,
    resolvePostPairingPrompt: deps.resolvePostPairingPrompt,
    renderPairingRepairedNotice: deps.renderPairingRepairedNotice,
    renderPairingTakeoverNotice: deps.renderPairingTakeoverNotice,
    renderPairingSuccessNotice: deps.renderPairingSuccessNotice,
    renderWhatsAppContactTip: deps.renderWhatsAppContactTip,
    log: deps.log,
    buildInboundAuthHeaders,
  });

  return {
    mintRuntimeJwt,
    buildInboundAuthHeaders,
    isWhatsAppCommandText,
    hasWhatsAppMessageContent,
    sendWhatsAppPairingNotice,
    resolveTelegramBoundRoute,
    resolveDiscordBoundRoute,
    resolveWhatsAppBoundRoute,
    resolveIMessageBoundRoute,
    resolveDiscordOutboundChannelId,
    resolveTelegramIncomingTopicId,
    resolveTelegramBindingForIncoming,
    resolveWhatsAppBindingForIncoming,
    resolveIMessageBindingForIncoming,
    deactivateLiveBinding,
    setBindingPending,
    resolveBindingSessionKey,
    sendPostPairingSyntheticInbound: postPairingDelivery.sendPostPairingSyntheticInbound,
    renderNoticeForClaimType: postPairingDelivery.renderNoticeForClaimType,
    sendPostClaimNotices: postPairingDelivery.sendPostClaimNotices,
    forwardDiscordMessageToTenant: discordForwarding.forwardDiscordMessageToTenant,
    registerOpenClawInstance,
    upsertTenantInboundTargetByAdmin,
    resolveStoredTelegramOffset,
    storeTelegramOffset,
    resolveStoredDiscordOffset,
    storeDiscordOffset,
    resolveDiscordInboundChannelId,
  };
}
