import { chunkText } from "../../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../../globals.js";
import { sendPollWhatsApp } from "../../../web/outbound.js";
import { buildWhatsAppRawSend } from "../mux-envelope.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { createWhatsAppOutboundBase } from "../whatsapp-shared.js";
import { sendTextMediaPayload } from "./direct-text-media.js";
import { isMuxEnabled, sendViaMux } from "./mux.js";

function trimLeadingWhitespace(text: string | undefined): string {
  return text?.trimStart() ?? "";
}

export const whatsappOutbound: ChannelOutboundAdapter = {
  ...createWhatsAppOutboundBase({
    chunker: chunkText,
    sendMessageWhatsApp: async (...args) =>
      (await import("../../../web/outbound.js")).sendMessageWhatsApp(...args),
    sendPollWhatsApp,
    shouldLogVerbose,
    normalizeText: trimLeadingWhitespace,
    skipEmptyText: true,
  }),
  sendText: async ({ cfg, to, text, accountId, deps, gifPlayback, sessionKey }) => {
    const normalizedText = trimLeadingWhitespace(text);
    if (!normalizedText) {
      return { channel: "whatsapp", messageId: "" };
    }
    if (isMuxEnabled({ cfg, channel: "whatsapp", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "whatsapp",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text: normalizedText,
        raw: {
          whatsapp: buildWhatsAppRawSend({
            text: normalizedText,
            gifPlayback,
          }),
        },
      });
      return { channel: "whatsapp", ...result };
    }
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, normalizedText, {
      verbose: false,
      cfg,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
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
    const normalizedText = trimLeadingWhitespace(text);
    if (isMuxEnabled({ cfg, channel: "whatsapp", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "whatsapp",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text: normalizedText,
        mediaUrl,
        raw: {
          whatsapp: buildWhatsAppRawSend({
            text: normalizedText,
            mediaUrl,
            gifPlayback,
          }),
        },
      });
      return { channel: "whatsapp", ...result };
    }
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, normalizedText, {
      verbose: false,
      cfg,
      mediaUrl,
      mediaLocalRoots,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendPoll: async ({ cfg, to, poll, accountId }) => {
    if (isMuxEnabled({ cfg, channel: "whatsapp", accountId: accountId ?? undefined })) {
      throw new Error("whatsapp mux poll delivery requires sessionKey; use routed replies instead");
    }
    return await sendPollWhatsApp(to, poll, {
      verbose: shouldLogVerbose(),
      accountId: accountId ?? undefined,
      cfg,
    });
  },
  sendPayload: async (ctx) => {
    const text = trimLeadingWhitespace(ctx.payload.text);
    const hasMedia = Boolean(ctx.payload.mediaUrl) || (ctx.payload.mediaUrls?.length ?? 0) > 0;
    if (!text && !hasMedia) {
      return { channel: "whatsapp", messageId: "" };
    }
    if (
      isMuxEnabled({ cfg: ctx.cfg, channel: "whatsapp", accountId: ctx.accountId ?? undefined })
    ) {
      const rawWhatsApp = (
        ctx.payload.channelData as { raw?: { whatsapp?: Record<string, unknown> } } | undefined
      )?.raw?.whatsapp;
      const result = await sendViaMux({
        cfg: ctx.cfg,
        channel: "whatsapp",
        accountId: ctx.accountId ?? undefined,
        sessionKey: ctx.sessionKey,
        to: ctx.to,
        text,
        mediaUrl: ctx.payload.mediaUrl,
        mediaUrls: ctx.payload.mediaUrls,
        replyToId: ctx.replyToId,
        threadId: ctx.threadId,
        channelData:
          typeof ctx.payload.channelData === "object" && ctx.payload.channelData
            ? ctx.payload.channelData
            : undefined,
        raw: {
          whatsapp:
            rawWhatsApp ??
            buildWhatsAppRawSend({
              text,
              mediaUrl: ctx.payload.mediaUrl,
              mediaUrls: ctx.payload.mediaUrls,
              gifPlayback: ctx.gifPlayback,
            }),
        },
      });
      return { channel: "whatsapp", ...result };
    }
    return await sendTextMediaPayload({
      channel: "whatsapp",
      ctx: {
        ...ctx,
        payload: {
          ...ctx.payload,
          text,
        },
      },
      adapter: whatsappOutbound,
    });
  },
};
