import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../../config/config.js";
import type { PollInput } from "../../../polls.js";

type SupportedMuxChannel = "whatsapp" | "telegram" | "discord";

type ResolvedChannelMuxConfig = {
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
};

type MuxSendRequest = {
  cfg: OpenClawConfig;
  channel: SupportedMuxChannel;
  accountId?: string;
  sessionKey?: string | null;
  to?: string;
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string | null;
  threadId?: string | number | null;
  channelData?: Record<string, unknown>;
  poll?: PollInput;
};

type MuxSendResponse = {
  messageId: string;
  chatId?: string;
  channelId?: string;
  toJid?: string;
  conversationId?: string;
  pollId?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeBaseUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeChannelMuxConfig(
  raw: { enabled?: boolean; baseUrl?: string; apiKey?: string; timeoutMs?: number } | undefined,
): ResolvedChannelMuxConfig {
  return {
    enabled: raw?.enabled === true,
    baseUrl: normalizeBaseUrl(raw?.baseUrl),
    apiKey: readString(raw?.apiKey),
    timeoutMs:
      typeof raw?.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
        ? Math.trunc(raw.timeoutMs)
        : DEFAULT_TIMEOUT_MS,
  };
}

function resolveChannelMuxConfig(params: {
  cfg: OpenClawConfig;
  channel: SupportedMuxChannel;
  accountId?: string;
}): ResolvedChannelMuxConfig {
  const { cfg, channel, accountId } = params;
  if (channel === "telegram") {
    const channelCfg = cfg.channels?.telegram;
    const accountCfg = accountId ? channelCfg?.accounts?.[accountId] : undefined;
    return normalizeChannelMuxConfig(accountCfg?.mux ?? channelCfg?.mux);
  }
  if (channel === "discord") {
    const channelCfg = cfg.channels?.discord;
    const accountCfg = accountId ? channelCfg?.accounts?.[accountId] : undefined;
    return normalizeChannelMuxConfig(accountCfg?.mux ?? channelCfg?.mux);
  }
  const channelCfg = cfg.channels?.whatsapp;
  const accountCfg = accountId ? channelCfg?.accounts?.[accountId] : undefined;
  return normalizeChannelMuxConfig(accountCfg?.mux ?? channelCfg?.mux);
}

export function isMuxEnabled(params: {
  cfg: OpenClawConfig;
  channel: SupportedMuxChannel;
  accountId?: string;
}): boolean {
  return resolveChannelMuxConfig(params).enabled;
}

function requireMuxConfig(params: {
  cfg: OpenClawConfig;
  channel: SupportedMuxChannel;
  accountId?: string;
  sessionKey?: string | null;
}): {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  sessionKey: string;
} {
  const resolved = resolveChannelMuxConfig(params);
  if (!resolved.enabled) {
    throw new Error(`mux is not enabled for channel ${params.channel}`);
  }
  if (!resolved.baseUrl) {
    throw new Error(`channels.${params.channel}.mux.baseUrl is required when mux is enabled`);
  }
  if (!resolved.apiKey) {
    throw new Error(`channels.${params.channel}.mux.apiKey is required when mux is enabled`);
  }
  const sessionKey = readString(params.sessionKey);
  if (!sessionKey) {
    throw new Error(`mux outbound for ${params.channel} requires a sessionKey`);
  }
  return {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    timeoutMs: resolved.timeoutMs,
    sessionKey,
  };
}

function mapMuxSendResponse(
  channel: SupportedMuxChannel,
  payload: Record<string, unknown>,
): MuxSendResponse {
  const providerMessageIds = Array.isArray(payload.providerMessageIds)
    ? payload.providerMessageIds
    : undefined;
  const firstProviderMessageId =
    providerMessageIds && providerMessageIds.length > 0
      ? readString(providerMessageIds[0])
      : undefined;
  const messageId =
    readString(payload.messageId) ??
    readString(payload.deliveryId) ??
    firstProviderMessageId ??
    "unknown";

  return {
    messageId,
    chatId: readString(payload.chatId),
    channelId: readString(payload.channelId),
    toJid: channel === "whatsapp" ? readString(payload.toJid) : undefined,
    conversationId: readString(payload.conversationId),
    pollId: readString(payload.pollId),
  };
}

export async function sendViaMux(params: MuxSendRequest): Promise<MuxSendResponse> {
  const resolved = requireMuxConfig({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    sessionKey: params.sessionKey,
  });

  const url = `${resolved.baseUrl}/v1/mux/outbound/send`;
  const payload = {
    requestId: randomUUID(),
    channel: params.channel,
    sessionKey: resolved.sessionKey,
    accountId: params.accountId,
    to: params.to,
    text: params.text ?? "",
    mediaUrl: params.mediaUrl,
    mediaUrls: params.mediaUrls,
    replyToId: params.replyToId ?? undefined,
    threadId: params.threadId ?? undefined,
    channelData: params.channelData,
    poll: params.poll,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
      "Idempotency-Key": payload.requestId,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(resolved.timeoutMs),
  });

  const bodyText = await response.text();
  let parsedBody: unknown = {};
  if (bodyText.trim()) {
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      parsedBody = { raw: bodyText };
    }
  }
  if (!response.ok) {
    const summary =
      typeof parsedBody === "object" && parsedBody !== null
        ? JSON.stringify(parsedBody)
        : bodyText || `${response.status}`;
    throw new Error(`mux outbound failed (${response.status}): ${summary}`);
  }
  if (typeof parsedBody !== "object" || parsedBody === null) {
    return { messageId: "unknown" };
  }
  return mapMuxSendResponse(params.channel, parsedBody as Record<string, unknown>);
}
