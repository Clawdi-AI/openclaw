import type { MuxConfig } from "../config/env.js";
import type { PreparedStatements } from "../db/statements.js";
import { buildDiscordInboundEnvelope } from "../mux-envelope.js";
import { createInboundTraceId } from "../observability/tracing.js";
import type { DiscordBoundRoute, TenantInboundTarget } from "./types.js";
import { asRecord, readNonEmptyString } from "./values.js";

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

export function createDiscordForwardingService(deps: {
  db: Pick<PreparedStatements, "stmtUpsertSessionRoute">;
  config: Pick<MuxConfig, "openclawMuxAccountId">;
  getDiscordBotSelfId: () => string | null;
  getDiscordRuntimeHealth: () => { lastInboundSeenAtMs: number | null };
  resolveDiscordInboundSessionKey: (params: {
    tenantId: string;
    bindingId: string;
    route: DiscordBoundRoute;
    channelId: string;
  }) => string;
  extractDiscordInboundMedia: (params: {
    message: Record<string, unknown>;
    messageId: string;
  }) => Promise<{
    attachments: MuxInboundAttachment[];
    media: InboundMediaSummary[];
  }>;
  resolveTenantInboundTarget: (tenantId: string) => TenantInboundTarget | null;
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
  log: (entry: Record<string, unknown>) => void;
  buildInboundAuthHeaders: (
    target: TenantInboundTarget,
    traceId?: string,
  ) => Promise<Record<string, string>>;
}) {
  async function forwardDiscordMessageToTenant(params: {
    tenantId: string;
    bindingId: string;
    routeKey: string;
    route: DiscordBoundRoute;
    channelId: string;
    message: Record<string, unknown>;
    messageId: string;
    fromId: string;
    body: string;
  }): Promise<"forwarded" | "ignored" | "deferred"> {
    deps.metrics.recordActiveUser("discord", params.fromId);
    deps.getDiscordRuntimeHealth().lastInboundSeenAtMs = Date.now();
    const traceId = createInboundTraceId({
      channel: "discord",
      tenantId: params.tenantId,
      routeKey: params.routeKey,
      messageId: params.messageId,
    });
    const target = deps.resolveTenantInboundTarget(params.tenantId);
    if (!target) {
      deps.metrics.recordInboundEvent("discord", "dropped");
      deps.log({
        type: "discord_inbound_drop_no_target",
        tenantId: params.tenantId,
        bindingId: params.bindingId,
        routeKey: params.routeKey,
        traceId,
      });
      return "deferred";
    }

    const inboundMedia = await deps.extractDiscordInboundMedia({
      message: params.message,
      messageId: params.messageId,
    });

    const sessionKey = deps.resolveDiscordInboundSessionKey({
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      route: params.route,
      channelId: params.channelId,
    });

    deps.db.stmtUpsertSessionRoute.run(
      params.tenantId,
      "discord",
      sessionKey,
      params.bindingId,
      JSON.stringify({ routeKey: params.routeKey, channelId: params.channelId }),
      Date.now(),
    );

    const timestampMs = (() => {
      const timestampRaw =
        typeof params.message.timestamp === "string" ? Date.parse(params.message.timestamp) : NaN;
      return Number.isFinite(timestampRaw) ? Math.trunc(timestampRaw) : Date.now();
    })();

    // Best-effort wasMentioned for backward compat with old gateways that
    // don't yet compute mentions from raw data.
    const discordBotSelfId = deps.getDiscordBotSelfId();
    let legacyWasMentioned = false;
    if (discordBotSelfId) {
      const mentions = Array.isArray(params.message.mentions) ? params.message.mentions : [];
      legacyWasMentioned = mentions.some(
        (m: unknown) =>
          asRecord(m) != null && readNonEmptyString(asRecord(m)?.id) === discordBotSelfId,
      );
      if (!legacyWasMentioned && params.body) {
        legacyWasMentioned =
          params.body.includes(`<@${discordBotSelfId}>`) ||
          params.body.includes(`<@!${discordBotSelfId}>`);
      }
    }

    const payload = buildDiscordInboundEnvelope({
      messageId: params.messageId,
      sessionKey,
      accountId: deps.config.openclawMuxAccountId,
      rawBody: params.body,
      fromId: params.fromId,
      channelId: params.channelId,
      guildId: params.route.kind === "guild" ? params.route.guildId : null,
      routeKey: params.routeKey,
      chatType: params.route.kind === "dm" ? "direct" : "group",
      timestampMs,
      threadId: params.route.kind === "guild" ? params.route.threadId : undefined,
      rawMessage: params.message,
      media: inboundMedia.media,
      attachments: inboundMedia.attachments,
      botUserId: discordBotSelfId,
      wasMentioned: legacyWasMentioned,
    });
    const payloadWithIdentity = {
      ...payload,
      openclawId: params.tenantId,
    };

    const forwardStartedAtMs = Date.now();
    let response: Response;
    try {
      response = await fetch(target.url, {
        method: "POST",
        headers: {
          ...(await deps.buildInboundAuthHeaders(target, traceId)),
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payloadWithIdentity),
        signal: AbortSignal.timeout(target.timeoutMs),
      });
    } catch (error) {
      deps.metrics.observeInboundForwardDuration("discord", Date.now() - forwardStartedAtMs);
      deps.metrics.recordInboundEvent("discord", "deferred");
      deps.log({
        type: "discord_inbound_retry_deferred",
        tenantId: params.tenantId,
        bindingId: params.bindingId,
        messageId: params.messageId,
        error: String(error),
        traceId,
      });
      return "deferred";
    }
    if (!response.ok) {
      deps.metrics.observeInboundForwardDuration("discord", Date.now() - forwardStartedAtMs);
      deps.metrics.recordInboundEvent("discord", "deferred");
      const bodyText = await response.text();
      deps.log({
        type: "discord_inbound_retry_deferred",
        tenantId: params.tenantId,
        bindingId: params.bindingId,
        messageId: params.messageId,
        error: `openclaw inbound failed (${response.status}): ${bodyText || "no body"}`,
        traceId,
      });
      return "deferred";
    }

    deps.metrics.observeInboundForwardDuration("discord", Date.now() - forwardStartedAtMs);
    deps.metrics.recordInboundEvent("discord", "forwarded");
    deps.log({
      type: "discord_inbound_forwarded",
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      channelId: params.channelId,
      sessionKey,
      messageId: params.messageId,
      traceId,
    });
    return "forwarded";
  }

  return { forwardDiscordMessageToTenant };
}
