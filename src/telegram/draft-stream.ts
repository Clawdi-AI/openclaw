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
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
};

export function createTelegramDraftStream(params: {
  transport: TelegramDraftStreamTransport;
  maxChars?: number;
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
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
    // Allow final flush even if stopped (e.g., after clear()).
    if (stopped && !isFinal) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    if (trimmed.length > maxChars) {
      // Telegram text messages/edits cap at 4096 chars.
      // Stop streaming once we exceed the cap to avoid repeated API failures.
      stopped = true;
      params.warn?.(
        `telegram stream preview stopped (text length ${trimmed.length} > ${maxChars})`,
      );
      return false;
    }
    if (trimmed === lastSentText) {
      return true;
    }

    // Debounce first preview send for better push notification quality.
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

/**
 * Attempt to finalize a draft stream by editing an existing preview message
 * to the final text, avoiding a redundant send+delete cycle.
 *
 * Returns `true` when the edit succeeded (caller should skip fallback delivery).
 */
export async function tryFinalizeDraftAsEdit(params: {
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

  // stop() may have flushed a debounced message that didn't exist before.
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

/**
 * Handle final payload delivery through the draft preview path when possible.
 * Encapsulates:
 * - regressive-text suppression (avoid overwriting richer preview with shorter final)
 * - finalize-via-edit fast path
 */
export async function handleDraftFinalPayload(params: {
  draftStream: TelegramDraftStream | undefined;
  alreadyFinalizedViaPreview: boolean;
  currentPreviewText: string;
  finalText: string | undefined;
  hasMedia: boolean;
  isError: boolean;
  maxChars?: number;
  editFn: (messageId: number, text: string) => Promise<void>;
  log?: (message: string) => void;
}): Promise<{
  finalizedViaPreview: boolean;
  handledByDraftPath: boolean;
}> {
  if (!params.draftStream || params.alreadyFinalizedViaPreview) {
    return {
      finalizedViaPreview: params.alreadyFinalizedViaPreview,
      handledByDraftPath: false,
    };
  }

  // Regressive text suppression (direct path only): ignore final edits
  // shorter than the current preview (e.g., "Okay." -> "Ok").
  if (
    params.draftStream.messageId() &&
    params.currentPreviewText &&
    typeof params.finalText === "string" &&
    params.currentPreviewText.startsWith(params.finalText) &&
    params.finalText.length < params.currentPreviewText.length
  ) {
    await params.draftStream.stop();
    return {
      // Keep preview as the delivered final result.
      finalizedViaPreview: true,
      handledByDraftPath: true,
    };
  }

  const finalized = await tryFinalizeDraftAsEdit({
    draftStream: params.draftStream,
    finalText: params.finalText,
    hasMedia: params.hasMedia,
    isError: params.isError,
    maxChars: params.maxChars,
    editFn: params.editFn,
    log: params.log,
  });
  return {
    finalizedViaPreview: finalized ? true : params.alreadyFinalizedViaPreview,
    handledByDraftPath: finalized,
  };
}

/**
 * Clean up a draft stream after delivery completes.
 * Always stops the stream; clears (deletes preview message) only when
 * the final text was NOT already edited in-place via `tryFinalizeDraftAsEdit`.
 */
export async function cleanupDraftStream(
  draftStream: TelegramDraftStream,
  finalizedViaEdit: boolean,
): Promise<void> {
  if (finalizedViaEdit) {
    await draftStream.stop();
    return;
  }
  await draftStream.clear();
}
