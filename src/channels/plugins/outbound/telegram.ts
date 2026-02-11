import type { ChannelOutboundAdapter } from "../types.js";
import { markdownToTelegramHtmlChunks } from "../../../telegram/format.js";
import { sendMessageTelegram } from "../../../telegram/send.js";
import { isMuxEnabled, sendViaMux } from "./mux.js";

type TelegramButtons = Array<Array<{ text: string; callback_data: string }>>;

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

function buildTelegramReplyMarkup(buttons?: TelegramButtons) {
  if (!buttons?.length) {
    return undefined;
  }
  const rows = buttons
    .map((row) =>
      row
        .filter((button) => button?.text && button?.callback_data)
        .map((button) => ({
          text: button.text,
          callback_data: button.callback_data,
        })),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    return undefined;
  }
  return { inline_keyboard: rows };
}

function buildTelegramRawSend(params: {
  to: string;
  text: string;
  mediaUrl?: string;
  buttons?: TelegramButtons;
  messageThreadId?: number;
  replyToMessageId?: number;
  quoteText?: string;
}) {
  const replyMarkup = buildTelegramReplyMarkup(params.buttons);
  const replyParams =
    params.replyToMessageId == null
      ? {}
      : params.quoteText
        ? {
            reply_parameters: {
              message_id: Math.trunc(params.replyToMessageId),
              quote: params.quoteText,
            },
          }
        : { reply_to_message_id: Math.trunc(params.replyToMessageId) };
  const baseBody = {
    chat_id: params.to,
    ...(params.messageThreadId != null ? { message_thread_id: params.messageThreadId } : {}),
    ...replyParams,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
  if (params.mediaUrl) {
    return {
      method: "sendPhoto" as const,
      body: {
        ...baseBody,
        photo: params.mediaUrl,
        ...(params.text ? { caption: params.text, parse_mode: "HTML" as const } : {}),
      },
    };
  }
  return {
    method: "sendMessage" as const,
    body: {
      ...baseBody,
      text: params.text,
      parse_mode: "HTML" as const,
    },
  };
}

export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, sessionKey }) => {
    const replyToMessageId = parseReplyToMessageId(replyToId);
    const messageThreadId = parseThreadId(threadId);
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
        raw: {
          telegram: buildTelegramRawSend({
            to,
            text,
            messageThreadId,
            replyToMessageId,
          }),
        },
      });
      return { channel: "telegram", ...result };
    }
    const send = deps?.sendTelegram ?? sendMessageTelegram;
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
    const replyToMessageId = parseReplyToMessageId(replyToId);
    const messageThreadId = parseThreadId(threadId);
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
        raw: {
          telegram: buildTelegramRawSend({
            to,
            text,
            mediaUrl,
            messageThreadId,
            replyToMessageId,
          }),
        },
      });
      return { channel: "telegram", ...result };
    }
    const send = deps?.sendTelegram ?? sendMessageTelegram;
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
    const replyToMessageId = parseReplyToMessageId(replyToId);
    const messageThreadId = parseThreadId(threadId);
    const telegramData = payload.channelData?.telegram as
      | { buttons?: TelegramButtons; quoteText?: string }
      | undefined;
    const quoteText =
      typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
    const text = payload.text ?? "";
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];

    if (isMuxEnabled({ cfg, channel: "telegram", accountId: accountId ?? undefined })) {
      if (mediaUrls.length === 0) {
        const result = await sendViaMux({
          cfg,
          channel: "telegram",
          accountId: accountId ?? undefined,
          sessionKey,
          to,
          text,
          replyToId,
          threadId,
          channelData:
            typeof payload.channelData === "object" && payload.channelData !== null
              ? payload.channelData
              : undefined,
          raw: {
            telegram: buildTelegramRawSend({
              to,
              text,
              buttons: telegramData?.buttons,
              quoteText,
              messageThreadId,
              replyToMessageId,
            }),
          },
        });
        return { channel: "telegram", ...result };
      }

      let finalResult:
        | {
            messageId: string;
            chatId?: string;
            channelId?: string;
            toJid?: string;
            conversationId?: string;
            pollId?: string;
          }
        | undefined;
      for (let i = 0; i < mediaUrls.length; i += 1) {
        const mediaUrl = mediaUrls[i];
        const isFirst = i === 0;
        finalResult = await sendViaMux({
          cfg,
          channel: "telegram",
          accountId: accountId ?? undefined,
          sessionKey,
          to,
          text: isFirst ? text : "",
          mediaUrl,
          replyToId,
          threadId,
          channelData:
            typeof payload.channelData === "object" && payload.channelData !== null
              ? payload.channelData
              : undefined,
          raw: {
            telegram: buildTelegramRawSend({
              to,
              text: isFirst ? text : "",
              mediaUrl,
              buttons: isFirst ? telegramData?.buttons : undefined,
              quoteText,
              messageThreadId,
              replyToMessageId,
            }),
          },
        });
      }
      return { channel: "telegram", ...(finalResult ?? { messageId: "unknown", chatId: to }) };
    }
    const send = deps?.sendTelegram ?? sendMessageTelegram;
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
