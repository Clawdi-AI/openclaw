import { sendMessageDiscord, sendPollDiscord } from "../../../discord/send.js";
import { normalizeDiscordOutboundTarget } from "../normalize/discord.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { maybeSendDiscordViaMux } from "./mux-overlay.js";
import { isMuxEnabled } from "./mux.js";

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, silent, sessionKey }) => {
    const muxResult = await maybeSendDiscordViaMux({
      cfg,
      accountId,
      sessionKey,
      to,
      text,
      replyToId,
    });
    if (muxResult) {
      return { channel: "discord", ...muxResult };
    }
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const sendResult = await send(to, text, {
      verbose: false,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
    });
    return { channel: "discord", ...sendResult };
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
    silent,
    sessionKey,
  }) => {
    const muxResult = await maybeSendDiscordViaMux({
      cfg,
      accountId,
      sessionKey,
      to,
      text,
      mediaUrl,
      replyToId,
    });
    if (muxResult) {
      return { channel: "discord", ...muxResult };
    }
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const sendResult = await send(to, text, {
      verbose: false,
      mediaUrl,
      mediaLocalRoots,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
    });
    return { channel: "discord", ...sendResult };
  },
  sendPoll: async ({ cfg, to, poll, accountId, silent, sessionKey }) => {
    if (isMuxEnabled({ cfg, channel: "discord", accountId: accountId ?? undefined })) {
      if (!sessionKey?.trim()) {
        throw new Error(
          "discord mux poll delivery requires sessionKey; use routed replies instead",
        );
      }
      const result = await maybeSendDiscordViaMux({
        cfg,
        accountId,
        sessionKey,
        to,
        text: "",
        poll,
      });
      if (result) {
        return { channel: "discord", ...result };
      }
    }
    return await sendPollDiscord(to, poll, {
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
    });
  },
};
