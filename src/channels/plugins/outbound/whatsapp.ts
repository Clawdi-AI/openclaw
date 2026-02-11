import type { ChannelOutboundAdapter } from "../types.js";
import { chunkText } from "../../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../../globals.js";
import { missingTargetError } from "../../../infra/outbound/target-errors.js";
import { sendPollWhatsApp } from "../../../web/outbound.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../../whatsapp/normalize.js";
import { buildWhatsAppRawSend } from "../mux-envelope.js";
import { isMuxEnabled, sendViaMux } from "./mux.js";

export const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  resolveTarget: ({ to, allowFrom, mode }) => {
    const trimmed = to?.trim() ?? "";
    const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
    const hasWildcard = allowListRaw.includes("*");
    const allowList = allowListRaw
      .filter((entry) => entry !== "*")
      .map((entry) => normalizeWhatsAppTarget(entry))
      .filter((entry): entry is string => Boolean(entry));

    if (trimmed) {
      const normalizedTo = normalizeWhatsAppTarget(trimmed);
      if (!normalizedTo) {
        if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
          return { ok: true, to: allowList[0] };
        }
        return {
          ok: false,
          error: missingTargetError(
            "WhatsApp",
            "<E.164|group JID> or channels.whatsapp.allowFrom[0]",
          ),
        };
      }
      if (isWhatsAppGroupJid(normalizedTo)) {
        return { ok: true, to: normalizedTo };
      }
      if (mode === "implicit" || mode === "heartbeat") {
        if (hasWildcard || allowList.length === 0) {
          return { ok: true, to: normalizedTo };
        }
        if (allowList.includes(normalizedTo)) {
          return { ok: true, to: normalizedTo };
        }
        return { ok: true, to: allowList[0] };
      }
      return { ok: true, to: normalizedTo };
    }

    if (allowList.length > 0) {
      return { ok: true, to: allowList[0] };
    }
    return {
      ok: false,
      error: missingTargetError("WhatsApp", "<E.164|group JID> or channels.whatsapp.allowFrom[0]"),
    };
  },
  sendText: async ({ cfg, to, text, accountId, deps, gifPlayback, sessionKey }) => {
    if (isMuxEnabled({ cfg, channel: "whatsapp", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "whatsapp",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        raw: {
          whatsapp: buildWhatsAppRawSend({
            text,
            gifPlayback,
          }),
        },
      });
      return { channel: "whatsapp", ...result };
    }
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, text, {
      verbose: false,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps, gifPlayback, sessionKey }) => {
    if (isMuxEnabled({ cfg, channel: "whatsapp", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "whatsapp",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        mediaUrl,
        raw: {
          whatsapp: buildWhatsAppRawSend({
            text,
            mediaUrl,
            gifPlayback,
          }),
        },
      });
      return { channel: "whatsapp", ...result };
    }
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
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
    });
  },
};
