import type { OpenClawConfig } from "../../../config/config.js";
import type { PollInput } from "../../../polls.js";
import type { MuxTransportOpts } from "../../../telegram/send.js";
import { buildDiscordRawSend, buildWhatsAppRawSend } from "../mux-envelope.js";
import { isMuxEnabled, sendViaMux } from "./mux.js";

type CommonMuxParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  sessionKey?: string | null;
};

type DiscordMuxParams = CommonMuxParams & {
  to: string;
  text: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string | null;
  threadId?: string | number | null;
  channelData?: Record<string, unknown>;
  poll?: PollInput;
  rawDiscord?: Record<string, unknown>;
};

type WhatsAppMuxParams = CommonMuxParams & {
  to: string;
  text: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string | null;
  threadId?: string | number | null;
  channelData?: Record<string, unknown>;
  poll?: PollInput;
  gifPlayback?: boolean;
  rawWhatsApp?: Record<string, unknown>;
};

function firstMediaUrl(mediaUrl?: string, mediaUrls?: string[]) {
  return mediaUrl ?? (Array.isArray(mediaUrls) && mediaUrls.length > 0 ? mediaUrls[0] : undefined);
}

export function resolveTelegramMuxTransportOpts(
  params: CommonMuxParams,
): MuxTransportOpts | undefined {
  if (
    !isMuxEnabled({
      cfg: params.cfg,
      channel: "telegram",
      accountId: params.accountId ?? undefined,
    })
  ) {
    return undefined;
  }
  return {
    cfg: params.cfg,
    sessionKey: params.sessionKey ?? "",
  };
}

export async function maybeSendDiscordViaMux(params: DiscordMuxParams) {
  if (
    !isMuxEnabled({
      cfg: params.cfg,
      channel: "discord",
      accountId: params.accountId ?? undefined,
    })
  ) {
    return undefined;
  }

  const rawDiscord =
    params.rawDiscord ??
    buildDiscordRawSend({
      text: params.text,
      mediaUrl: firstMediaUrl(params.mediaUrl, params.mediaUrls),
      replyToId: params.replyToId ?? undefined,
    });

  return await sendViaMux({
    cfg: params.cfg,
    channel: "discord",
    accountId: params.accountId ?? undefined,
    sessionKey: params.sessionKey,
    to: params.to,
    text: params.text,
    mediaUrl: params.mediaUrl,
    mediaUrls: params.mediaUrls,
    replyToId: params.replyToId,
    threadId: params.threadId,
    channelData: params.channelData,
    poll: params.poll,
    raw: { discord: rawDiscord },
  });
}

export async function maybeSendWhatsAppViaMux(params: WhatsAppMuxParams) {
  if (
    !isMuxEnabled({
      cfg: params.cfg,
      channel: "whatsapp",
      accountId: params.accountId ?? undefined,
    })
  ) {
    return undefined;
  }

  const rawWhatsApp =
    params.rawWhatsApp ??
    buildWhatsAppRawSend({
      text: params.text,
      mediaUrl: firstMediaUrl(params.mediaUrl, params.mediaUrls),
      gifPlayback: params.gifPlayback,
    });

  return await sendViaMux({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: params.accountId ?? undefined,
    sessionKey: params.sessionKey,
    to: params.to,
    text: params.text,
    mediaUrl: params.mediaUrl,
    mediaUrls: params.mediaUrls,
    replyToId: params.replyToId,
    threadId: params.threadId,
    channelData: params.channelData,
    poll: params.poll,
    raw: { whatsapp: rawWhatsApp },
  });
}
