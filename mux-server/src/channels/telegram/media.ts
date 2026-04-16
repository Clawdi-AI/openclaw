import path from "node:path";
import { readNonEmptyString, readPositiveInt } from "../../domain/values.js";
import type { MuxInboundAttachment } from "../../mux-envelope.js";

type TelegramPhotoSize = {
  file_id?: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
};

type TelegramDocument = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramVideo = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration?: number;
  file_size?: number;
};

type TelegramAnimation = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration?: number;
  file_size?: number;
};

type TelegramVoice = {
  file_id?: string;
  mime_type?: string;
  duration?: number;
  file_size?: number;
};

type TelegramAudio = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  duration?: number;
  file_size?: number;
};

type TelegramVideoNote = {
  file_id?: string;
  length?: number;
  duration?: number;
  file_size?: number;
};

type TelegramInboundAttachment = MuxInboundAttachment;

type TelegramInboundMediaSummary = {
  kind: string;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  filePath?: string;
};

type TelegramIncomingMessage = {
  message_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  animation?: TelegramAnimation;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  video_note?: TelegramVideoNote;
  from?: { id?: number; username?: string };
  chat?: { id?: number; type?: string; is_forum?: boolean };
  entities?: Array<{ type?: string; offset?: number; length?: number }>;
  reply_to_message?: { from?: { username?: string } };
};

export const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".weba": "audio/webm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

export function inferMimeTypeFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const ext = path.extname(filePath).toLowerCase();
  return ext ? MIME_BY_EXT[ext] : undefined;
}

export function createTelegramMediaService(deps: {
  muxPublicUrl: string;
  requireTelegramBotToken: () => string;
  telegramApiBaseUrl: string;
}) {
  function pickBestTelegramPhotoSize(
    sizes: TelegramPhotoSize[] | undefined,
  ): TelegramPhotoSize | null {
    if (!Array.isArray(sizes) || sizes.length === 0) {
      return null;
    }
    const candidates = sizes.filter((entry) => readNonEmptyString(entry.file_id));
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => {
      const aSize = readPositiveInt(a.file_size) ?? 0;
      const bSize = readPositiveInt(b.file_size) ?? 0;
      if (aSize !== bSize) {
        return bSize - aSize;
      }
      const aArea = (readPositiveInt(a.width) ?? 0) * (readPositiveInt(a.height) ?? 0);
      const bArea = (readPositiveInt(b.width) ?? 0) * (readPositiveInt(b.height) ?? 0);
      return bArea - aArea;
    });
    return candidates[0] ?? null;
  }

  async function resolveTelegramFilePath(fileId: string): Promise<string | null> {
    const token = deps.requireTelegramBotToken();
    const response = await fetch(`${deps.telegramApiBaseUrl}/bot${token}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!response.ok) {
      return null;
    }
    const result = (await response.json()) as {
      ok?: boolean;
      result?: { file_path?: unknown } | null;
    };
    if (result.ok !== true) {
      return null;
    }
    return readNonEmptyString(result.result?.file_path);
  }

  async function resolveTelegramAttachment(params: {
    updateId: number;
    kind: string;
    fileId: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
    width?: number;
    height?: number;
    durationSec?: number;
  }): Promise<{ attachment?: TelegramInboundAttachment; summary: TelegramInboundMediaSummary }> {
    const summary: TelegramInboundMediaSummary = {
      kind: params.kind,
      fileId: params.fileId,
      fileName: params.fileName,
      mimeType: params.mimeType,
      fileSize: params.fileSize,
      width: params.width,
      height: params.height,
      durationSec: params.durationSec,
    };
    const inferredMime =
      inferMimeTypeFromPath(params.fileName) ?? inferMimeTypeFromPath(params.fileName);
    const resolvedMime = params.mimeType || inferredMime;
    summary.mimeType = resolvedMime || summary.mimeType;
    summary.fileName =
      summary.fileName || (params.fileId ? `${params.kind}-${params.fileId}` : undefined);
    const proxyUrl = `${deps.muxPublicUrl}/v1/mux/files/telegram?fileId=${encodeURIComponent(params.fileId)}`;
    const attachment: TelegramInboundAttachment = {
      type: resolvedMime?.split("/")[0] || "file",
      mimeType: resolvedMime || "application/octet-stream",
      fileName: summary.fileName,
      url: proxyUrl,
    };
    return { attachment, summary };
  }

  async function extractTelegramInboundMedia(params: {
    message: TelegramIncomingMessage;
    updateId: number;
  }): Promise<{
    attachments: TelegramInboundAttachment[];
    media: TelegramInboundMediaSummary[];
  }> {
    const attachments: TelegramInboundAttachment[] = [];
    const media: TelegramInboundMediaSummary[] = [];

    const bestPhoto = pickBestTelegramPhotoSize(params.message.photo);
    const photoFileId = readNonEmptyString(bestPhoto?.file_id);
    if (photoFileId) {
      const result = await resolveTelegramAttachment({
        updateId: params.updateId,
        kind: "photo",
        fileId: photoFileId,
        mimeType: "image/jpeg",
        fileSize: readPositiveInt(bestPhoto?.file_size),
        width: readPositiveInt(bestPhoto?.width),
        height: readPositiveInt(bestPhoto?.height),
      });
      media.push(result.summary);
      if (result.attachment) {
        attachments.push(result.attachment);
      }
    }

    const document = params.message.document;
    const docFileId = readNonEmptyString(document?.file_id);
    const docMimeType = readNonEmptyString(document?.mime_type)?.toLowerCase();
    const docFileName = readNonEmptyString(document?.file_name);
    if (docFileId) {
      const result = await resolveTelegramAttachment({
        updateId: params.updateId,
        kind: "document",
        fileId: docFileId,
        fileName: docFileName ?? undefined,
        mimeType: docMimeType ?? inferMimeTypeFromPath(docFileName ?? undefined),
        fileSize: readPositiveInt(document?.file_size),
      });
      media.push(result.summary);
      if (result.attachment) {
        attachments.push(result.attachment);
      }
    }

    const video = params.message.video;
    const videoFileId = readNonEmptyString(video?.file_id);
    if (videoFileId) {
      const result = await resolveTelegramAttachment({
        updateId: params.updateId,
        kind: "video",
        fileId: videoFileId,
        fileName: readNonEmptyString(video?.file_name) ?? undefined,
        mimeType: readNonEmptyString(video?.mime_type)?.toLowerCase() ?? undefined,
        fileSize: readPositiveInt(video?.file_size),
        width: readPositiveInt(video?.width),
        height: readPositiveInt(video?.height),
        durationSec: readPositiveInt(video?.duration),
      });
      media.push(result.summary);
      if (result.attachment) {
        attachments.push(result.attachment);
      }
    }

    const animation = params.message.animation;
    const animationFileId = readNonEmptyString(animation?.file_id);
    if (animationFileId) {
      const result = await resolveTelegramAttachment({
        updateId: params.updateId,
        kind: "animation",
        fileId: animationFileId,
        fileName: readNonEmptyString(animation?.file_name) ?? undefined,
        mimeType: readNonEmptyString(animation?.mime_type)?.toLowerCase() ?? undefined,
        fileSize: readPositiveInt(animation?.file_size),
        width: readPositiveInt(animation?.width),
        height: readPositiveInt(animation?.height),
        durationSec: readPositiveInt(animation?.duration),
      });
      media.push(result.summary);
      if (result.attachment) {
        attachments.push(result.attachment);
      }
    }

    const voice = params.message.voice;
    const voiceFileId = readNonEmptyString(voice?.file_id);
    if (voiceFileId) {
      const result = await resolveTelegramAttachment({
        updateId: params.updateId,
        kind: "voice",
        fileId: voiceFileId,
        mimeType: readNonEmptyString(voice?.mime_type)?.toLowerCase() ?? "audio/ogg",
        fileSize: readPositiveInt(voice?.file_size),
        durationSec: readPositiveInt(voice?.duration),
      });
      media.push(result.summary);
      if (result.attachment) {
        attachments.push(result.attachment);
      }
    }

    const audio = params.message.audio;
    const audioFileId = readNonEmptyString(audio?.file_id);
    if (audioFileId) {
      const audioFileName = readNonEmptyString(audio?.file_name);
      const result = await resolveTelegramAttachment({
        updateId: params.updateId,
        kind: "audio",
        fileId: audioFileId,
        fileName: audioFileName ?? undefined,
        mimeType:
          readNonEmptyString(audio?.mime_type)?.toLowerCase() ??
          inferMimeTypeFromPath(audioFileName ?? undefined) ??
          "audio/mpeg",
        fileSize: readPositiveInt(audio?.file_size),
        durationSec: readPositiveInt(audio?.duration),
      });
      media.push(result.summary);
      if (result.attachment) {
        attachments.push(result.attachment);
      }
    }

    const videoNote = params.message.video_note;
    const videoNoteFileId = readNonEmptyString(videoNote?.file_id);
    if (videoNoteFileId) {
      const side = readPositiveInt(videoNote?.length);
      const result = await resolveTelegramAttachment({
        updateId: params.updateId,
        kind: "video_note",
        fileId: videoNoteFileId,
        mimeType: "video/mp4",
        fileSize: readPositiveInt(videoNote?.file_size),
        width: side,
        height: side,
        durationSec: readPositiveInt(videoNote?.duration),
      });
      media.push(result.summary);
      if (result.attachment) {
        attachments.push(result.attachment);
      }
    }

    return { attachments, media };
  }

  return {
    resolveTelegramFilePath,
    extractTelegramInboundMedia,
  };
}
