import type { ChannelOutboundAdapter } from "../types.js";
import { sendMessageDiscord, sendPollDiscord } from "../../../discord/send.js";
import { buildDiscordRawSend } from "../mux-envelope.js";
import { isMuxEnabled, sendViaMux } from "./mux.js";

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, sessionKey }) => {
    if (isMuxEnabled({ cfg, channel: "discord", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "discord",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        replyToId,
        raw: {
          discord: buildDiscordRawSend({
            text,
            replyToId,
          }),
        },
      });
      return { channel: "discord", ...result };
    }
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, text, {
      verbose: false,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps, replyToId, sessionKey }) => {
    if (isMuxEnabled({ cfg, channel: "discord", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "discord",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        mediaUrl,
        replyToId,
        raw: {
          discord: buildDiscordRawSend({
            text,
            mediaUrl,
            replyToId,
          }),
        },
      });
      return { channel: "discord", ...result };
    }
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendPoll: async ({ cfg, to, poll, accountId }) => {
    if (isMuxEnabled({ cfg, channel: "discord", accountId: accountId ?? undefined })) {
      throw new Error("discord mux poll delivery requires sessionKey; use routed replies instead");
    }
    return await sendPollDiscord(to, poll, {
      accountId: accountId ?? undefined,
    });
  },
};
