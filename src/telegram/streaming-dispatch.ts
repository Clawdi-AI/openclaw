import { createDraftStreamLoop } from "../channels/draft-stream-loop.js";

const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1000;

export type TelegramDraftStreamTransport = {
  send: (text: string) => Promise<{ messageId: number }>;
  edit: (messageId: number, text: string) => Promise<void>;
  delete?: (messageId: number) => Promise<void>;
};

export type TelegramDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => number | undefined;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  forceNewMessage: () => void;
};

export function createTelegramDraftStream(params: {
  transport: TelegramDraftStreamTransport;
  maxChars?: number;
  throttleMs?: number;
  minInitialChars?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream {
  const maxChars = Math.min(
    params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS,
    TELEGRAM_STREAM_MAX_CHARS,
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const transport = params.transport;

  let streamMessageId: number | undefined;
  let lastSentText = "";
  let stopped = false;
  let isFinal = false;

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (stopped && !isFinal) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    if (trimmed.length > maxChars) {
      stopped = true;
      params.warn?.(
        `telegram stream preview stopped (text length ${trimmed.length} > ${maxChars})`,
      );
      return false;
    }
    if (trimmed === lastSentText) {
      return true;
    }
    if (typeof streamMessageId !== "number" && minInitialChars != null && !isFinal) {
      if (trimmed.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = trimmed;
    try {
      if (typeof streamMessageId === "number") {
        await transport.edit(streamMessageId, trimmed);
        return true;
      }
      const sent = await transport.send(trimmed);
      const sentMessageId = sent?.messageId;
      if (typeof sentMessageId !== "number" || !Number.isFinite(sentMessageId)) {
        stopped = true;
        params.warn?.("telegram stream preview stopped (missing message id from sendMessage)");
        return false;
      }
      streamMessageId = Math.trunc(sentMessageId);
      return true;
    } catch (err) {
      stopped = true;
      params.warn?.(
        `telegram stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const loop = createDraftStreamLoop({
    throttleMs,
    isStopped: () => stopped,
    sendOrEditStreamMessage,
  });

  const update = (text: string) => {
    if (stopped || isFinal) {
      return;
    }
    loop.update(text);
  };

  const stop = async (): Promise<void> => {
    isFinal = true;
    await loop.flush();
  };

  const clear = async () => {
    stopped = true;
    loop.stop();
    await loop.waitForInFlight();
    const messageId = streamMessageId;
    streamMessageId = undefined;
    if (typeof messageId !== "number") {
      return;
    }
    try {
      await transport.delete?.(messageId);
    } catch (err) {
      params.warn?.(
        `telegram stream preview cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const forceNewMessage = () => {
    streamMessageId = undefined;
    lastSentText = "";
    loop.resetPending();
  };

  params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    clear,
    stop,
    forceNewMessage,
  };
}

async function tryFinalizeDraftAsEdit(params: {
  draftStream: TelegramDraftStream;
  finalText: string | undefined;
  hasMedia: boolean;
  isError: boolean;
  maxChars?: number;
  editFn: (messageId: number, text: string) => Promise<void>;
  log?: (message: string) => void;
}): Promise<boolean> {
  const { draftStream, finalText, hasMedia, isError, editFn, log } = params;
  const maxChars = params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS;

  await draftStream.flush();
  const previewId = draftStream.messageId();

  const canEdit =
    typeof finalText === "string" &&
    finalText.length > 0 &&
    finalText.length <= maxChars &&
    !hasMedia &&
    !isError;

  let stopped = false;

  if (typeof previewId === "number" && canEdit) {
    await draftStream.stop();
    stopped = true;
    try {
      await editFn(previewId, finalText);
      return true;
    } catch (err) {
      log?.(`telegram: preview final edit failed; falling back to standard send (${String(err)})`);
    }
  }

  if (typeof finalText === "string" && finalText.length > maxChars && !hasMedia && !isError) {
    log?.(
      `telegram: preview final too long for edit (${finalText.length} > ${maxChars}); falling back to standard send`,
    );
  }

  if (!stopped) {
    await draftStream.stop();
  }

  const messageIdAfterStop = draftStream.messageId();
  if (typeof messageIdAfterStop === "number" && canEdit) {
    try {
      await editFn(messageIdAfterStop, finalText);
      return true;
    } catch (err) {
      log?.(
        `telegram: post-stop preview edit failed; falling back to standard send (${String(err)})`,
      );
    }
  }

  return false;
}

async function cleanupDraftStream(
  draftStream: TelegramDraftStream,
  keepPreviewMessage: boolean,
): Promise<void> {
  if (keepPreviewMessage) {
    await draftStream.stop();
    return;
  }
  await draftStream.clear();
}

type TelegramStreamingDispatchParams = {
  transport: TelegramDraftStreamTransport;
  editFn: (messageId: number, text: string) => Promise<void>;
  maxChars?: number;
  minInitialChars?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

export type TelegramStreamingDispatch = {
  draftStream: TelegramDraftStream;
  onPartialReply: (payload: { text?: string }) => void;
  tryFinalize: (payload: {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    isError?: boolean;
  }) => Promise<boolean>;
  cleanup: () => Promise<void>;
};

export function createTelegramStreamingDispatch(
  params: TelegramStreamingDispatchParams,
): TelegramStreamingDispatch {
  const draftStream = createTelegramDraftStream({
    transport: params.transport,
    maxChars: params.maxChars,
    minInitialChars: params.minInitialChars ?? 30,
    log: params.log,
    warn: params.warn,
  });

  let lastPartialText = "";
  let finalizedViaPreviewMessage = false;

  return {
    draftStream,
    onPartialReply: (payload) => {
      const text = payload.text;
      if (!text || text === lastPartialText) {
        return;
      }
      if (
        lastPartialText &&
        lastPartialText.startsWith(text) &&
        text.length < lastPartialText.length
      ) {
        return;
      }
      lastPartialText = text;
      draftStream.update(text);
    },
    tryFinalize: async (payload) => {
      if (finalizedViaPreviewMessage) {
        return false;
      }
      const finalized = await tryFinalizeDraftAsEdit({
        draftStream,
        finalText: payload.text,
        hasMedia: Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0,
        isError: payload.isError ?? false,
        maxChars: params.maxChars,
        editFn: params.editFn,
        log: params.log,
      });
      if (finalized) {
        finalizedViaPreviewMessage = true;
      }
      return finalized;
    },
    cleanup: () => cleanupDraftStream(draftStream, finalizedViaPreviewMessage),
  };
}
