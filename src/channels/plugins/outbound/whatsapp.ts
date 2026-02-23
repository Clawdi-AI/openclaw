import { chunkText } from "../../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../../globals.js";
import { sendPollWhatsApp } from "../../../web/outbound.js";
import { resolveWhatsAppOutboundTarget } from "../../../whatsapp/resolve-outbound-target.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { maybeSendWhatsAppViaMux } from "./mux-overlay.js";
import { resolvePayloadTextAndMedia, sendPayloadWithMediaSequence } from "./payload-sequence.js";

export const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  resolveTarget: ({ to, allowFrom, mode }) =>
    resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  sendText: async ({ cfg, to, text, accountId, deps, gifPlayback, sessionKey }) => {
    const muxResult = await maybeSendWhatsAppViaMux({
      cfg,
      accountId,
      sessionKey,
      to,
      text,
      gifPlayback,
    });
    if (muxResult) {
      return { channel: "whatsapp", ...muxResult };
    }
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const sendResult = await send(to, text, {
      verbose: false,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...sendResult };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    gifPlayback,
    sessionKey,
  }) => {
    const muxResult = await maybeSendWhatsAppViaMux({
      cfg,
      accountId,
      sessionKey,
      to,
      text,
      mediaUrl,
      gifPlayback,
    });
    if (muxResult) {
      return { channel: "whatsapp", ...muxResult };
    }
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const sendResult = await send(to, text, {
      verbose: false,
      mediaUrl,
      mediaLocalRoots,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...sendResult };
  },
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    accountId,
    deps,
    gifPlayback,
    replyToId,
    threadId,
    sessionKey,
  }) => {
    const channelData =
      typeof payload.channelData === "object" && payload.channelData !== null
        ? payload.channelData
        : undefined;
    const rawWhatsApp = (
      channelData as { raw?: { whatsapp?: Record<string, unknown> } } | undefined
    )?.raw?.whatsapp;
    const muxResult = await maybeSendWhatsAppViaMux({
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
      gifPlayback,
      rawWhatsApp,
    });
    if (muxResult) {
      return { channel: "whatsapp", ...muxResult };
    }

    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const { text, mediaUrls } = resolvePayloadTextAndMedia(payload);
    const result = await sendPayloadWithMediaSequence({
      text,
      mediaUrls,
      sendSingle: async ({ text, mediaUrl }) =>
        await send(to, text, {
          verbose: false,
          mediaUrl,
          mediaLocalRoots,
          accountId: accountId ?? undefined,
          gifPlayback,
        }),
    });
    return { channel: "whatsapp", ...result };
  },
  sendPoll: async ({ cfg, to, poll, accountId, sessionKey }) => {
    const result = await maybeSendWhatsAppViaMux({
      cfg,
      accountId,
      sessionKey,
      to,
      text: "",
      poll,
    });
    if (result) {
      return { channel: "whatsapp", ...result };
    }
    return await sendPollWhatsApp(to, poll, {
      verbose: shouldLogVerbose(),
      accountId: accountId ?? undefined,
    });
  },
};
