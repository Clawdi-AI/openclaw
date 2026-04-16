import { normalizeControlText, readNonEmptyString, readPositiveInt } from "../../domain/values.js";

type TelegramParseMode = "HTML";

type TelegramIncomingMessage = {
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: unknown;
  video?: unknown;
  animation?: unknown;
  voice?: unknown;
  audio?: unknown;
  video_note?: unknown;
};

const ALLOWED_TELEGRAM_METHODS = new Set([
  // Sending
  "sendMessage",
  "sendPhoto",
  "sendDocument",
  "sendAnimation",
  "sendVideo",
  "sendVideoNote",
  "sendVoice",
  "sendAudio",
  "sendSticker",
  "sendPoll",
  "sendChatAction",
  // Editing / deleting
  "editMessageText",
  "deleteMessage",
  // Reactions
  "setMessageReaction",
  // Callbacks
  "answerCallbackQuery",
  // Bot menu
  "setMyCommands",
  "deleteMyCommands",
  // Forum topics
  "createForumTopic",
]);

const TELEGRAM_PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;

function readTelegramResultDescription(result: Record<string, unknown>): string {
  const description = result.description;
  return typeof description === "string" ? description : "";
}

export function createTelegramApiService(deps: {
  telegramApiBaseUrl: string;
  telegramGeneralTopicId: number;
  requireTelegramBotToken: () => string;
}) {
  function isTelegramMessageNotModified(method: string, result: Record<string, unknown>): boolean {
    return (
      method === "editMessageText" &&
      /message is not modified/i.test(readTelegramResultDescription(result))
    );
  }

  function shouldRetryTelegramWithoutHtmlParseMode(params: {
    method: string;
    body: Record<string, unknown>;
    result: Record<string, unknown>;
  }): boolean {
    if (params.method !== "sendMessage" && params.method !== "editMessageText") {
      return false;
    }
    const parseMode = readNonEmptyString(params.body.parse_mode);
    if (!parseMode || parseMode.toLowerCase() !== "html") {
      return false;
    }
    return TELEGRAM_PARSE_ERR_RE.test(readTelegramResultDescription(params.result));
  }

  function shouldRetryTelegramWithoutThread(params: {
    body: Record<string, unknown>;
    result: Record<string, unknown>;
  }): boolean {
    return (
      readPositiveInt(params.body.message_thread_id) !== undefined &&
      /message thread not found/i.test(readTelegramResultDescription(params.result))
    );
  }

  async function withTelegramThreadFallback(params: {
    body: Record<string, unknown>;
    attempt: (
      effectiveBody: Record<string, unknown>,
    ) => Promise<{ response: Response; result: Record<string, unknown> }>;
  }): Promise<{
    response: Response;
    result: Record<string, unknown>;
  }> {
    let finalBody: Record<string, unknown> = { ...params.body };
    let attempt = await params.attempt(finalBody);
    if (
      (!attempt.response.ok || attempt.result.ok !== true) &&
      shouldRetryTelegramWithoutThread({
        body: finalBody,
        result: attempt.result,
      })
    ) {
      finalBody = { ...finalBody };
      delete finalBody.message_thread_id;
      attempt = await params.attempt(finalBody);
    }
    return attempt;
  }

  async function sendTelegram(method: string, body: Record<string, unknown>) {
    const token = deps.requireTelegramBotToken();
    const url = `${deps.telegramApiBaseUrl}/bot${token}/${method}`;

    // When __fileBase64 is present, the openclaw side is sending a local file
    // that needs to be uploaded via multipart form data.
    const fileBase64 = typeof body.__fileBase64 === "string" ? body.__fileBase64 : undefined;
    const fileField = typeof body.__fileField === "string" ? body.__fileField : undefined;
    const fileName = typeof body.__fileName === "string" ? body.__fileName : "file";

    if (fileBase64 && fileField) {
      const cleanBody = { ...body };
      delete cleanBody.__fileBase64;
      delete cleanBody.__fileField;
      delete cleanBody.__fileName;

      const formData = new FormData();
      const fileBuffer = Buffer.from(fileBase64, "base64");
      formData.append(fileField, new Blob([fileBuffer]), fileName);

      for (const [key, value] of Object.entries(cleanBody)) {
        if (value == null) {
          continue;
        }
        formData.append(
          key,
          typeof value === "object"
            ? JSON.stringify(value)
            : String(value as string | number | boolean),
        );
      }

      const response = await fetch(url, { method: "POST", body: formData });
      const result = (await response.json()) as Record<string, unknown>;
      return { response, result };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as Record<string, unknown>;
    return { response, result };
  }

  async function sendTelegramWithFallbacks(params: {
    method: string;
    body: Record<string, unknown>;
  }): Promise<{
    response: Response;
    result: Record<string, unknown>;
  }> {
    return await withTelegramThreadFallback({
      body: params.body,
      attempt: async (effectiveBody) => {
        let finalBody: Record<string, unknown> = { ...effectiveBody };
        let { response, result } = await sendTelegram(params.method, finalBody);
        if (
          (!response.ok || result.ok !== true) &&
          shouldRetryTelegramWithoutHtmlParseMode({
            method: params.method,
            body: finalBody,
            result,
          })
        ) {
          finalBody = { ...finalBody };
          delete finalBody.parse_mode;
          ({ response, result } = await sendTelegram(params.method, finalBody));
        }
        return { response, result };
      },
    });
  }

  function isTelegramCommandText(input: string | null): boolean {
    const normalized = normalizeControlText(input);
    if (!normalized) {
      return false;
    }
    return /^\/[A-Za-z0-9_]+/.test(normalized);
  }

  function hasTelegramMessageContent(message: TelegramIncomingMessage): boolean {
    if (normalizeControlText(message.text ?? message.caption ?? null)) {
      return true;
    }
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      return true;
    }
    return Boolean(
      message.document ||
      message.video ||
      message.animation ||
      message.voice ||
      message.audio ||
      message.video_note,
    );
  }

  async function sendTelegramPairingNotice(params: {
    chatId: string;
    topicId?: number;
    text: string;
    parseMode?: TelegramParseMode;
  }) {
    const isGeneralForumTopic =
      params.topicId === deps.telegramGeneralTopicId && params.chatId.startsWith("-");
    const canUseThreadId = Boolean(params.topicId) && !isGeneralForumTopic;
    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      text: params.text,
    };
    if (params.parseMode) {
      body.parse_mode = params.parseMode;
    }
    if (canUseThreadId && params.topicId) {
      body.message_thread_id = params.topicId;
    }
    const attempt = await withTelegramThreadFallback({
      body,
      attempt: async (effectiveBody) => await sendTelegram("sendMessage", effectiveBody),
    });
    if (attempt.response.ok && attempt.result.ok === true) {
      return;
    }
    throw new Error(`telegram pairing notice failed (${attempt.response.status})`);
  }

  async function answerTelegramCallbackQuery(params: {
    callbackQueryId: string;
    text?: string;
  }): Promise<void> {
    const body: Record<string, unknown> = {
      callback_query_id: params.callbackQueryId,
    };
    const text = readNonEmptyString(params.text);
    if (text) {
      body.text = text;
    }
    const { response, result } = await sendTelegram("answerCallbackQuery", body);
    if (!response.ok || result.ok !== true) {
      throw new Error(`telegram answerCallbackQuery failed (${response.status})`);
    }
  }

  return {
    ALLOWED_TELEGRAM_METHODS,
    sendTelegram,
    sendTelegramWithFallbacks,
    isTelegramMessageNotModified,
    isTelegramCommandText,
    hasTelegramMessageContent,
    sendTelegramPairingNotice,
    answerTelegramCallbackQuery,
  };
}
