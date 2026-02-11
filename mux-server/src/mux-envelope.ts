// Transport contract helpers.
// Inbound text must be preserved as-is; attachments/channelData are additive.

export type MuxPayload = {
  requestId?: unknown;
  channel?: unknown;
  sessionKey?: unknown;
  accountId?: unknown;
  to?: unknown;
  text?: unknown;
  mediaUrl?: unknown;
  mediaUrls?: unknown;
  replyToId?: unknown;
  threadId?: unknown;
  channelData?: unknown;
  poll?: unknown;
};

export type MuxInboundAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content: string;
};

type MuxInboundEnvelope = {
  eventId: string;
  channel: "telegram" | "discord" | "whatsapp";
  sessionKey: string;
  body: string;
  from: string;
  to: string;
  accountId: string;
  chatType: "direct" | "group";
  messageId: string;
  timestampMs: number;
  threadId?: number | string;
  channelData: Record<string, unknown>;
  attachments?: MuxInboundAttachment[];
};

export function readOutboundText(payload: MuxPayload): { text: string; hasText: boolean } {
  const text = typeof payload.text === "string" ? payload.text : "";
  return { text, hasText: text.trim().length > 0 };
}

export function collectOutboundMediaUrls(payload: MuxPayload): string[] {
  const collected: string[] = [];
  const single = typeof payload.mediaUrl === "string" ? payload.mediaUrl : "";
  if (single.trim().length > 0) {
    collected.push(single);
  }
  const list = Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [];
  for (const item of list) {
    if (typeof item !== "string") {
      continue;
    }
    if (item.trim().length > 0) {
      collected.push(item);
    }
  }
  return collected;
}

export function buildTelegramInboundEnvelope(params: {
  updateId: number;
  sessionKey: string;
  accountId: string;
  rawBody: string;
  fromId: string;
  chatId: string;
  topicId?: number;
  chatType: "direct" | "group";
  messageId: string;
  timestampMs: number;
  routeKey: string;
  rawMessage: unknown;
  rawUpdate: unknown;
  media: unknown;
  attachments: MuxInboundAttachment[];
}): MuxInboundEnvelope {
  const payload: MuxInboundEnvelope = {
    eventId: `tg:${params.updateId}`,
    channel: "telegram",
    sessionKey: params.sessionKey,
    body: params.rawBody,
    from: `telegram:${params.fromId}`,
    to: `telegram:${params.chatId}`,
    accountId: params.accountId,
    chatType: params.chatType,
    messageId: params.messageId,
    timestampMs: params.timestampMs,
    ...(typeof params.topicId === "number" ? { threadId: params.topicId } : {}),
    channelData: {
      accountId: params.accountId,
      messageId: params.messageId,
      chatId: params.chatId,
      topicId: params.topicId ?? null,
      routeKey: params.routeKey,
      updateId: params.updateId,
      telegram: {
        media: params.media,
        rawMessage: params.rawMessage,
        rawUpdate: params.rawUpdate,
      },
    },
  };
  if (params.attachments.length > 0) {
    payload.attachments = params.attachments;
  }
  return payload;
}

export function buildDiscordInboundEnvelope(params: {
  messageId: string;
  sessionKey: string;
  accountId: string;
  rawBody: string;
  fromId: string;
  channelId: string;
  guildId: string | null;
  routeKey: string;
  chatType: "direct" | "group";
  timestampMs: number;
  threadId?: string;
  rawMessage: unknown;
  media: unknown;
  attachments: MuxInboundAttachment[];
}): MuxInboundEnvelope {
  const payload: MuxInboundEnvelope = {
    eventId: `dc:${params.messageId}`,
    channel: "discord",
    sessionKey: params.sessionKey,
    body: params.rawBody,
    from: `discord:${params.fromId}`,
    to: `channel:${params.channelId}`,
    accountId: params.accountId,
    chatType: params.chatType,
    messageId: params.messageId,
    timestampMs: params.timestampMs,
    ...(params.threadId ? { threadId: params.threadId } : {}),
    channelData: {
      accountId: params.accountId,
      messageId: params.messageId,
      channelId: params.channelId,
      guildId: params.guildId,
      routeKey: params.routeKey,
      discord: {
        media: params.media,
        rawMessage: params.rawMessage,
      },
    },
  };
  if (params.attachments.length > 0) {
    payload.attachments = params.attachments;
  }
  return payload;
}

export function buildWhatsAppInboundEnvelope(params: {
  messageId: string;
  sessionKey: string;
  openclawAccountId: string;
  rawBody: string;
  fromId: string;
  chatJid: string;
  routeKey: string;
  accountId: string;
  chatType: "direct" | "group";
  timestampMs: number;
  rawMessage: unknown;
  media: unknown;
  attachments: MuxInboundAttachment[];
}): MuxInboundEnvelope {
  const payload: MuxInboundEnvelope = {
    eventId: `wa:${params.messageId}`,
    channel: "whatsapp",
    sessionKey: params.sessionKey,
    body: params.rawBody,
    from: `whatsapp:${params.fromId}`,
    to: `whatsapp:${params.chatJid}`,
    accountId: params.openclawAccountId,
    chatType: params.chatType,
    messageId: params.messageId,
    timestampMs: params.timestampMs,
    channelData: {
      accountId: params.accountId,
      messageId: params.messageId,
      chatJid: params.chatJid,
      routeKey: params.routeKey,
      whatsapp: {
        media: params.media,
        rawMessage: params.rawMessage,
      },
    },
  };
  if (params.attachments.length > 0) {
    payload.attachments = params.attachments;
  }
  return payload;
}
