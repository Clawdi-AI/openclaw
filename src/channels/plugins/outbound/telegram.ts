import { markdownToTelegramHtmlChunks } from "../../../telegram/format.js";
import {
  parseTelegramReplyToMessageId,
  parseTelegramThreadId,
} from "../../../telegram/outbound-params.js";
import { sendMessageTelegram, sendPollTelegram } from "../../../telegram/send.js";
import { type TelegramButtons } from "../mux-envelope.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { resolveTelegramMuxTransportOpts } from "./mux-overlay.js";
import { resolvePayloadTextAndMedia, sendPayloadWithMediaSequence } from "./payload-sequence.js";

export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  pollMaxOptions: 10,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, silent, sessionKey }) => {
    const replyToMessageId = parseTelegramReplyToMessageId(replyToId);
    const messageThreadId = parseTelegramThreadId(threadId);
    const mux = resolveTelegramMuxTransportOpts({ cfg, accountId, sessionKey });
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const result = await send(to, text, {
      verbose: false,
      textMode: "html",
      messageThreadId,
      replyToMessageId,
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
      mux,
    });
    return { channel: "telegram", ...result };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
    silent,
    sessionKey,
  }) => {
    const replyToMessageId = parseTelegramReplyToMessageId(replyToId);
    const messageThreadId = parseTelegramThreadId(threadId);
    const mux = resolveTelegramMuxTransportOpts({ cfg, accountId, sessionKey });
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      textMode: "html",
      messageThreadId,
      replyToMessageId,
      accountId: accountId ?? undefined,
      mediaLocalRoots,
      silent: silent ?? undefined,
      mux,
    });
    return { channel: "telegram", ...result };
  },
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
    sessionKey,
  }) => {
    const replyToMessageId = parseTelegramReplyToMessageId(replyToId);
    const messageThreadId = parseTelegramThreadId(threadId);
    const telegramData = payload.channelData?.telegram as
      | { buttons?: TelegramButtons; quoteText?: string }
      | undefined;
    const quoteText =
      typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
    const { text, mediaUrls } = resolvePayloadTextAndMedia(payload);

    const mux = resolveTelegramMuxTransportOpts({ cfg, accountId, sessionKey });
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const baseOpts = {
      verbose: false,
      textMode: "html" as const,
      messageThreadId,
      replyToMessageId,
      quoteText,
      accountId: accountId ?? undefined,
      mediaLocalRoots,
      mux,
    };

    const result = await sendPayloadWithMediaSequence({
      text,
      mediaUrls,
      // Telegram allows reply_markup on media; attach buttons only to first send.
      sendSingle: async ({ text, mediaUrl, isFirst }) =>
        await send(to, text, {
          ...baseOpts,
          mediaUrl,
          ...(isFirst ? { buttons: telegramData?.buttons } : {}),
        }),
    });
    return { channel: "telegram", ...result };
  },
  sendPoll: async ({ cfg, to, poll, accountId, threadId, silent, isAnonymous, sessionKey }) =>
    await sendPollTelegram(to, poll, {
      accountId: accountId ?? undefined,
      messageThreadId: parseTelegramThreadId(threadId),
      silent: silent ?? undefined,
      isAnonymous: isAnonymous ?? undefined,
      mux: resolveTelegramMuxTransportOpts({ cfg, accountId, sessionKey }),
    }),
};
