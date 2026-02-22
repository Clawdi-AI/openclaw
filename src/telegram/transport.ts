import {
  buildTelegramRawCreateForumTopic,
  buildTelegramRawDeleteMessage,
  buildTelegramRawEditMessageText,
  buildTelegramRawSendMedia,
  buildTelegramRawSendPoll,
  buildTelegramRawSetMessageReaction,
} from "../channels/plugins/mux-envelope.js";
import { sendViaMux } from "../channels/plugins/outbound/mux.js";
import type { loadConfig } from "../config/config.js";

export type MuxTransportOpts = {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  accountId?: string;
};

export type TelegramTransport =
  | { kind: "direct" }
  | {
      kind: "mux";
      cfg: ReturnType<typeof loadConfig>;
      sessionKey: string;
      accountId?: string;
    };

type TelegramMuxTransport = Extract<TelegramTransport, { kind: "mux" }>;

export function resolveTelegramTransport(params: {
  mux?: MuxTransportOpts;
  accountId?: string;
}): TelegramTransport {
  if (!params.mux) {
    return { kind: "direct" };
  }
  return {
    kind: "mux",
    cfg: params.mux.cfg,
    sessionKey: params.mux.sessionKey,
    accountId: params.mux.accountId ?? params.accountId,
  };
}

export function isTelegramMuxTransport(
  transport: TelegramTransport,
): transport is TelegramMuxTransport {
  return transport.kind === "mux";
}

export async function sendTelegramMuxRaw(params: {
  transport: TelegramMuxTransport;
  raw: Record<string, unknown>;
}) {
  return await sendViaMux({
    cfg: params.transport.cfg,
    channel: "telegram",
    sessionKey: params.transport.sessionKey,
    accountId: params.transport.accountId,
    raw: { telegram: params.raw },
  });
}

export async function reactMessageTelegramViaMux(params: {
  transport: TelegramMuxTransport;
  messageId: number;
  emoji: string;
  remove?: boolean;
}): Promise<{ ok: true }> {
  await sendTelegramMuxRaw({
    transport: params.transport,
    raw: buildTelegramRawSetMessageReaction({
      messageId: params.messageId,
      emoji: params.emoji,
      remove: params.remove,
    }),
  });
  return { ok: true };
}

export async function deleteMessageTelegramViaMux(params: {
  transport: TelegramMuxTransport;
  messageId: number;
}): Promise<{ ok: true }> {
  await sendTelegramMuxRaw({
    transport: params.transport,
    raw: buildTelegramRawDeleteMessage({ messageId: params.messageId }),
  });
  return { ok: true };
}

export async function editMessageTelegramViaMux(params: {
  transport: TelegramMuxTransport;
  messageId: number;
  text: string;
}): Promise<{ ok: true }> {
  await sendTelegramMuxRaw({
    transport: params.transport,
    raw: buildTelegramRawEditMessageText({
      messageId: params.messageId,
      text: params.text,
      parseMode: "HTML",
    }),
  });
  return { ok: true };
}

export async function sendStickerTelegramViaMux(params: {
  transport: TelegramMuxTransport;
  chatId: string;
  fileId: string;
  messageThreadId?: number;
  replyToMessageId?: number;
}): Promise<{ messageId: string; chatId: string }> {
  const result = await sendTelegramMuxRaw({
    transport: params.transport,
    raw: buildTelegramRawSendMedia({
      method: "sendSticker",
      mediaUrl: params.fileId,
      messageThreadId: params.messageThreadId,
      replyToMessageId: params.replyToMessageId,
    }),
  });
  return {
    messageId: String(result.messageId ?? "unknown"),
    chatId: params.chatId,
  };
}

export async function sendPollTelegramViaMux(params: {
  transport: TelegramMuxTransport;
  chatId: string;
  question: string;
  options: string[];
  allowsMultipleAnswers: boolean;
  isAnonymous?: boolean;
  openPeriod?: number;
  messageThreadId?: number;
  replyToMessageId?: number;
  silent?: boolean;
}): Promise<{ messageId: string; chatId: string }> {
  const result = await sendTelegramMuxRaw({
    transport: params.transport,
    raw: buildTelegramRawSendPoll({
      question: params.question,
      options: params.options,
      allowsMultipleAnswers: params.allowsMultipleAnswers,
      isAnonymous: params.isAnonymous,
      openPeriod: params.openPeriod,
      messageThreadId: params.messageThreadId,
      replyToMessageId: params.replyToMessageId,
      silent: params.silent,
    }),
  });
  return {
    messageId: String(result.messageId ?? "unknown"),
    chatId: params.chatId,
  };
}

export async function createForumTopicTelegramViaMux(params: {
  transport: TelegramMuxTransport;
  chatId: string;
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
}): Promise<{ topicId: number; name: string; chatId: string }> {
  const result = (await sendTelegramMuxRaw({
    transport: params.transport,
    raw: buildTelegramRawCreateForumTopic({
      name: params.name,
      iconColor: params.iconColor,
      iconCustomEmojiId: params.iconCustomEmojiId,
    }),
  })) as Record<string, unknown>;
  return {
    topicId: typeof result.message_thread_id === "number" ? result.message_thread_id : 0,
    name: params.name,
    chatId: params.chatId,
  };
}
