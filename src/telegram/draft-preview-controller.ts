import type { TelegramDraftStream } from "./draft-stream.js";

export type TelegramDraftChunker = {
  hasBuffered: () => boolean;
  append: (text: string) => void;
  drain: (params: { force: boolean; emit: (chunk: string) => void }) => void;
  reset: () => void;
};

export type TelegramDraftPreviewController = {
  updateFromPartial: (text?: string) => void;
  flush: () => Promise<void>;
  onBoundary: () => void;
  currentPreviewText: () => string;
};

export function createTelegramDraftPreviewController(params: {
  draftStream?: TelegramDraftStream;
  streamMode: "off" | "partial" | "block";
  draftChunker?: TelegramDraftChunker;
}): TelegramDraftPreviewController {
  let lastPartialText = "";
  let draftText = "";
  let hasStreamedMessage = false;

  const resetDraftBuffers = () => {
    draftText = "";
    params.draftChunker?.reset();
  };
  const resetDraftPreviewState = () => {
    lastPartialText = "";
    resetDraftBuffers();
  };

  const updateFromPartial = (text?: string) => {
    if (!params.draftStream || !text) {
      return;
    }
    if (text === lastPartialText) {
      return;
    }
    // Mark that we've received streaming content (for forceNewMessage decision).
    hasStreamedMessage = true;
    if (params.streamMode === "partial") {
      // Some providers briefly emit a shorter prefix snapshot (for example
      // "Sure." -> "Sure" -> "Sure."). Keep the longer preview to avoid
      // visible punctuation flicker.
      if (
        lastPartialText &&
        lastPartialText.startsWith(text) &&
        text.length < lastPartialText.length
      ) {
        return;
      }
      lastPartialText = text;
      params.draftStream.update(text);
      return;
    }
    let delta = text;
    if (text.startsWith(lastPartialText)) {
      delta = text.slice(lastPartialText.length);
    } else {
      // Streaming buffer reset (or non-monotonic stream). Start fresh.
      resetDraftBuffers();
    }
    lastPartialText = text;
    if (!delta) {
      return;
    }
    if (!params.draftChunker) {
      draftText = text;
      params.draftStream.update(draftText);
      return;
    }
    params.draftChunker.append(delta);
    params.draftChunker.drain({
      force: false,
      emit: (chunk) => {
        draftText += chunk;
        params.draftStream?.update(draftText);
      },
    });
  };

  const flush = async () => {
    if (!params.draftStream) {
      return;
    }
    if (params.draftChunker?.hasBuffered()) {
      params.draftChunker.drain({
        force: true,
        emit: (chunk) => {
          draftText += chunk;
        },
      });
      params.draftChunker.reset();
      if (draftText) {
        params.draftStream.update(draftText);
      }
    }
    await params.draftStream.flush();
  };

  const onBoundary = () => {
    if (params.streamMode === "block" && hasStreamedMessage) {
      params.draftStream?.forceNewMessage();
    }
    resetDraftPreviewState();
  };

  const currentPreviewText = () => (params.streamMode === "block" ? draftText : lastPartialText);

  return {
    updateFromPartial,
    flush,
    onBoundary,
    currentPreviewText,
  };
}
