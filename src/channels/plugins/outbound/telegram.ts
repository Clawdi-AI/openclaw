import type { ChannelOutboundAdapter } from "../types.js";
import { markdownToTelegramHtmlChunks } from "../../../telegram/format.js";
import { sendMessageTelegram } from "../../../telegram/send.js";
import { isMuxEnabled, sendViaMux } from "./mux.js";

function parseReplyToMessageId(replyToId?: string | null) {
  if (!replyToId) {
    return undefined;
  }
  const parsed = Number.parseInt(replyToId, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseThreadId(threadId?: string | number | null) {
  if (threadId == null) {
    return undefined;
  }
  if (typeof threadId === "number") {
    return Number.isFinite(threadId) ? Math.trunc(threadId) : undefined;
  }
  const trimmed = threadId.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, sessionKey }) => {
    if (isMuxEnabled({ cfg, channel: "telegram", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "telegram",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        replyToId,
        threadId,
      });
      return { channel: "telegram", ...result };
    }
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const replyToMessageId = parseReplyToMessageId(replyToId);
    const messageThreadId = parseThreadId(threadId);
    const result = await send(to, text, {
      verbose: false,
      textMode: "html",
      messageThreadId,
      replyToMessageId,
      accountId: accountId ?? undefined,
    });
    return { channel: "telegram", ...result };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    accountId,
    deps,
    replyToId,
    threadId,
    sessionKey,
  }) => {
    if (isMuxEnabled({ cfg, channel: "telegram", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "telegram",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        mediaUrl,
        replyToId,
        threadId,
      });
      return { channel: "telegram", ...result };
    }
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const replyToMessageId = parseReplyToMessageId(replyToId);
    const messageThreadId = parseThreadId(threadId);
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      textMode: "html",
      messageThreadId,
      replyToMessageId,
      accountId: accountId ?? undefined,
    });
    return { channel: "telegram", ...result };
  },
  sendPayload: async ({ cfg, to, payload, accountId, deps, replyToId, threadId, sessionKey }) => {
    if (isMuxEnabled({ cfg, channel: "telegram", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "telegram",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text: payload.text ?? "",
        mediaUrl: payload.mediaUrl,
        mediaUrls: payload.mediaUrls,
        replyToId,
        threadId,
        channelData:
          typeof payload.channelData === "object" && payload.channelData !== null
            ? payload.channelData
            : undefined,
      });
      return { channel: "telegram", ...result };
    }
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const replyToMessageId = parseReplyToMessageId(replyToId);
    const messageThreadId = parseThreadId(threadId);
    const telegramData = payload.channelData?.telegram as
      | { buttons?: Array<Array<{ text: string; callback_data: string }>>; quoteText?: string }
      | undefined;
    const quoteText =
      typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
    const text = payload.text ?? "";
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];
    const baseOpts = {
      verbose: false,
      textMode: "html" as const,
      messageThreadId,
      replyToMessageId,
      quoteText,
      accountId: accountId ?? undefined,
    };

    if (mediaUrls.length === 0) {
      const result = await send(to, text, {
        ...baseOpts,
        buttons: telegramData?.buttons,
      });
      return { channel: "telegram", ...result };
    }

    // Telegram allows reply_markup on media; attach buttons only to first send.
    let finalResult: Awaited<ReturnType<typeof send>> | undefined;
    for (let i = 0; i < mediaUrls.length; i += 1) {
      const mediaUrl = mediaUrls[i];
      const isFirst = i === 0;
      finalResult = await send(to, isFirst ? text : "", {
        ...baseOpts,
        mediaUrl,
        ...(isFirst ? { buttons: telegramData?.buttons } : {}),
      });
    }
    return { channel: "telegram", ...(finalResult ?? { messageId: "unknown", chatId: to }) };
  },
};
