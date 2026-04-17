import { randomUUID } from "node:crypto";
import type { MuxConfig } from "../config/env.js";
import {
  buildDiscordInboundEnvelope,
  buildIMessageInboundEnvelope,
  buildTelegramInboundEnvelope,
  buildWhatsAppInboundEnvelope,
} from "../mux-envelope.js";
import { parseDiscordRouteKey, parseIMessageRouteKey } from "../routing/keys.js";
import type {
  ClaimResult,
  ClaimType,
  NoticeChannel,
  StyledNotice,
  TenantInboundTarget,
} from "./types.js";

export function createPostPairingDeliveryService(deps: {
  config: Pick<MuxConfig, "openclawMuxAccountId">;
  resolveTenantInboundTarget: (tenantId: string) => TenantInboundTarget | null;
  resolvePostPairingPrompt: (channel: NoticeChannel) => string;
  renderPairingRepairedNotice: (channel: NoticeChannel) => StyledNotice;
  renderPairingTakeoverNotice: (channel: NoticeChannel) => StyledNotice;
  renderPairingSuccessNotice: (channel: NoticeChannel) => StyledNotice;
  renderWhatsAppContactTip: (channel: NoticeChannel) => StyledNotice;
  log: (entry: Record<string, unknown>) => void;
  buildInboundAuthHeaders: (
    target: TenantInboundTarget,
    traceId?: string,
  ) => Promise<Record<string, string>>;
}) {
  async function sendPostPairingSyntheticInbound(params: {
    channel: NoticeChannel;
    tenantId: string;
    sessionKey: string;
    routeKey: string;
    fromId: string;
    chatId: string;
    chatType: "direct" | "group";
  }): Promise<void> {
    const target = deps.resolveTenantInboundTarget(params.tenantId);
    if (!target) {
      deps.log({
        type: "post_pairing_synthetic_skip_no_target",
        tenantId: params.tenantId,
        channel: params.channel,
      });
      return;
    }
    const prompt = deps.resolvePostPairingPrompt(params.channel);
    const now = Date.now();
    const syntheticId = `synth:pair:${randomUUID()}`;
    const discordRoute =
      params.channel === "discord" ? parseDiscordRouteKey(params.routeKey) : null;

    let payload: Record<string, unknown>;
    if (params.channel === "telegram") {
      payload = buildTelegramInboundEnvelope({
        updateId: 0,
        sessionKey: params.sessionKey,
        accountId: deps.config.openclawMuxAccountId,
        rawBody: prompt,
        fromId: params.fromId,
        chatId: params.chatId,
        topicId: undefined,
        chatType: params.chatType,
        messageId: syntheticId,
        timestampMs: now,
        routeKey: params.routeKey,
        rawMessage: {},
        rawUpdate: {},
        media: null,
        attachments: [],
      });
    } else if (params.channel === "discord") {
      payload = buildDiscordInboundEnvelope({
        messageId: syntheticId,
        sessionKey: params.sessionKey,
        accountId: deps.config.openclawMuxAccountId,
        rawBody: prompt,
        fromId: params.fromId,
        channelId: params.chatId,
        guildId: discordRoute?.kind === "guild" ? discordRoute.guildId : null,
        routeKey: params.routeKey,
        chatType: params.chatType,
        timestampMs: now,
        threadId: discordRoute?.kind === "guild" ? discordRoute.threadId : undefined,
        rawMessage: {},
        media: null,
        attachments: [],
      });
    } else if (params.channel === "imessage") {
      const imessageRoute = parseIMessageRouteKey(params.routeKey);
      payload = buildIMessageInboundEnvelope({
        messageId: syntheticId,
        sessionKey: params.sessionKey,
        accountId: deps.config.openclawMuxAccountId,
        body: prompt,
        from: params.fromId,
        chatGuid: imessageRoute?.chatGuid ?? params.chatId,
        chatType: params.chatType,
        routeKey: params.routeKey,
        timestampMs: now,
      });
    } else {
      payload = buildWhatsAppInboundEnvelope({
        messageId: syntheticId,
        sessionKey: params.sessionKey,
        openclawAccountId: deps.config.openclawMuxAccountId,
        rawBody: prompt,
        fromId: params.fromId,
        chatJid: params.chatId,
        routeKey: params.routeKey,
        accountId: params.chatId,
        chatType: params.chatType,
        timestampMs: now,
        rawMessage: {},
        media: null,
        attachments: [],
      });
    }

    const payloadWithIdentity = {
      ...payload,
      openclawId: params.tenantId,
    };

    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers: {
          ...(await deps.buildInboundAuthHeaders(target)),
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payloadWithIdentity),
        signal: AbortSignal.timeout(target.timeoutMs),
      });
      if (!response.ok) {
        const bodyText = await response.text();
        deps.log({
          type: "post_pairing_synthetic_error",
          tenantId: params.tenantId,
          channel: params.channel,
          status: response.status,
          body: bodyText.slice(0, 200),
        });
      } else {
        deps.log({
          type: "post_pairing_synthetic_sent",
          tenantId: params.tenantId,
          channel: params.channel,
          sessionKey: params.sessionKey,
        });
      }
    } catch (error) {
      deps.log({
        type: "post_pairing_synthetic_error",
        tenantId: params.tenantId,
        channel: params.channel,
        error: String(error),
      });
    }
  }

  function renderNoticeForClaimType(channel: NoticeChannel, claimType: ClaimType): StyledNotice {
    if (claimType === "repaired") {
      return deps.renderPairingRepairedNotice(channel);
    }
    if (claimType === "takeover") {
      return deps.renderPairingTakeoverNotice(channel);
    }
    return deps.renderPairingSuccessNotice(channel);
  }

  async function sendPostClaimNotices(params: {
    channel: NoticeChannel;
    claimed: ClaimResult;
    send: (notice: StyledNotice) => Promise<void>;
    fromId: string;
    chatId: string;
    chatType: "direct" | "group";
  }): Promise<void> {
    const notice = renderNoticeForClaimType(params.channel, params.claimed.claimType);
    await params.send(notice);

    if (params.claimed.claimType === "repaired") {
      return;
    }

    if (params.channel === "whatsapp") {
      try {
        const tip = deps.renderWhatsAppContactTip(params.channel);
        await params.send(tip);
      } catch (error) {
        deps.log({
          type: "whatsapp_contact_tip_error",
          tenantId: params.claimed.tenantId,
          error: String(error),
        });
      }
    }

    try {
      await sendPostPairingSyntheticInbound({
        channel: params.channel,
        tenantId: params.claimed.tenantId,
        sessionKey: params.claimed.sessionKey,
        routeKey: params.claimed.routeKey,
        fromId: params.fromId,
        chatId: params.chatId,
        chatType: params.chatType,
      });
    } catch (error) {
      deps.log({
        type: "post_pairing_synthetic_error",
        tenantId: params.claimed.tenantId,
        channel: params.channel,
        error: String(error),
      });
    }
  }

  return {
    sendPostPairingSyntheticInbound,
    renderNoticeForClaimType,
    sendPostClaimNotices,
  };
}
