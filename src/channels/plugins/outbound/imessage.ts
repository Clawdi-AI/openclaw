import { chunkText } from "../../../auto-reply/chunk.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { sendMessageIMessage } from "../../../imessage/send.js";
import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import { buildIMessageRawSend } from "../mux-envelope.js";
import type { ChannelOutboundAdapter } from "../types.js";
import {
  createScopedChannelMediaMaxBytesResolver,
  sendTextMediaPayload,
} from "./direct-text-media.js";
import { isMuxEnabled, sendViaMux } from "./mux.js";

const resolveIMessageMediaMaxBytes = createScopedChannelMediaMaxBytesResolver("imessage");

function resolveIMessageSender(deps: OutboundSendDeps | undefined) {
  return deps?.sendIMessage ?? sendMessageIMessage;
}

type IMessageSendParams = {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string | null;
  deps?: OutboundSendDeps;
  replyToId?: string | null;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
};

async function sendIMessageDirect(params: IMessageSendParams) {
  const send = resolveIMessageSender(params.deps);
  const maxBytes = resolveIMessageMediaMaxBytes({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const result = await send(params.to, params.text, {
    config: params.cfg,
    accountId: params.accountId ?? undefined,
    replyToId: params.replyToId ?? undefined,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(maxBytes != null ? { maxBytes } : {}),
  });
  return { channel: "imessage" as const, ...result };
}

export const imessageOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  sendPayload: async (ctx) => {
    if (
      isMuxEnabled({ cfg: ctx.cfg, channel: "imessage", accountId: ctx.accountId ?? undefined })
    ) {
      const rawIMessage = (
        ctx.payload.channelData as { raw?: { imessage?: Record<string, unknown> } } | undefined
      )?.raw?.imessage;
      const text = ctx.payload.text ?? "";
      const result = await sendViaMux({
        cfg: ctx.cfg,
        channel: "imessage",
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
          imessage:
            rawIMessage ??
            buildIMessageRawSend({
              text,
              mediaUrl: ctx.payload.mediaUrl,
              mediaUrls: ctx.payload.mediaUrls,
            }),
        },
      });
      return { channel: "imessage", ...result };
    }
    return await sendTextMediaPayload({ channel: "imessage", ctx, adapter: imessageOutbound });
  },
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, sessionKey }) => {
    if (isMuxEnabled({ cfg, channel: "imessage", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "imessage",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        replyToId,
        raw: {
          imessage: buildIMessageRawSend({ text }),
        },
      });
      return { channel: "imessage", ...result };
    }
    return await sendIMessageDirect({ cfg, to, text, accountId, deps, replyToId });
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
    sessionKey,
  }) => {
    if (isMuxEnabled({ cfg, channel: "imessage", accountId: accountId ?? undefined })) {
      const result = await sendViaMux({
        cfg,
        channel: "imessage",
        accountId: accountId ?? undefined,
        sessionKey,
        to,
        text,
        mediaUrl,
        replyToId,
        raw: {
          imessage: buildIMessageRawSend({ text, mediaUrl }),
        },
      });
      return { channel: "imessage", ...result };
    }
    return await sendIMessageDirect({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      accountId,
      deps,
      replyToId,
    });
  },
};
