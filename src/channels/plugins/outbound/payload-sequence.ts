import type { ReplyPayload } from "../../../auto-reply/types.js";

export type PayloadSendSequenceStep = {
  text: string;
  mediaUrl?: string;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  total: number;
};

export function resolvePayloadTextAndMedia(payload: ReplyPayload): {
  text: string;
  mediaUrls: string[];
} {
  const text = payload.text ?? "";
  const mediaUrls = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  return { text, mediaUrls };
}

export async function sendPayloadWithMediaSequence<T>(params: {
  text: string;
  mediaUrls: string[];
  sendSingle: (step: PayloadSendSequenceStep) => Promise<T>;
}): Promise<T> {
  if (params.mediaUrls.length === 0) {
    return await params.sendSingle({
      text: params.text,
      index: 0,
      isFirst: true,
      isLast: true,
      total: 1,
    });
  }

  let finalResult: T | undefined;
  for (let i = 0; i < params.mediaUrls.length; i += 1) {
    finalResult = await params.sendSingle({
      text: i === 0 ? params.text : "",
      mediaUrl: params.mediaUrls[i],
      index: i,
      isFirst: i === 0,
      isLast: i === params.mediaUrls.length - 1,
      total: params.mediaUrls.length,
    });
  }

  if (finalResult === undefined) {
    throw new Error("sendPayloadWithMediaSequence: missing final result");
  }
  return finalResult;
}
