import { sendMessageDiscord, sendPollDiscord } from "../../../discord/send.js";
import { normalizeDiscordOutboundTarget } from "../normalize/discord.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { maybeSendDiscordViaMux } from "./mux-overlay.js";
import { resolvePayloadTextAndMedia, sendPayloadWithMediaSequence } from "./payload-sequence.js";

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, silent, sessionKey }) => {
    const muxResult = await maybeSendDiscordViaMux({
      cfg,
      accountId,
      sessionKey,
      to,
      text,
      replyToId,
      threadId,
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
    threadId,
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
      threadId,
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
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
    silent,
    sessionKey,
  }) => {
    const channelData =
      typeof payload.channelData === "object" && payload.channelData !== null
        ? payload.channelData
        : undefined;
    const rawDiscord = (channelData as { raw?: { discord?: Record<string, unknown> } } | undefined)
      ?.raw?.discord;
    const muxResult = await maybeSendDiscordViaMux({
      cfg,
      accountId,
      sessionKey,
      to,
      text: payload.text ?? "",
      mediaUrl: payload.mediaUrl,
      mediaUrls: payload.mediaUrls,
      replyToId,
      threadId,
      channelData,
      rawDiscord,
    });
    if (muxResult) {
      return { channel: "discord", ...muxResult };
    }
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const { text, mediaUrls } = resolvePayloadTextAndMedia(payload);
    const result = await sendPayloadWithMediaSequence({
      text,
      mediaUrls,
      sendSingle: async ({ text, mediaUrl }) =>
        await send(to, text, {
          verbose: false,
          mediaUrl,
          mediaLocalRoots,
          replyTo: replyToId ?? undefined,
          accountId: accountId ?? undefined,
          silent: silent ?? undefined,
        }),
    });
    return { channel: "discord", ...result };
  },
  sendPoll: async ({ cfg, to, poll, accountId, silent, sessionKey }) => {
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
    return await sendPollDiscord(to, poll, {
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
    });
  },
};
