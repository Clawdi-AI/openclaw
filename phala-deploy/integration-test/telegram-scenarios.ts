import type { FakeOpenAiRequest, FakeOpenAiResponsePlan } from "./fake-openai.js";
import {
  createSequentialResponseScript,
  getFunctionCallOutput,
  streamingTextResponsePlan,
} from "./fake-openai.js";
import { loadJsonFixture } from "./fixtures.js";
import type { MuxOpenClawHarness } from "./mux-openclaw-harness.js";

type TelegramMessageUpdate = {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    text?: string;
    from: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      type: string;
    };
  };
};

type TelegramCallbackQueryUpdate = {
  update_id: number;
  callback_query: {
    id: string;
    from: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    data: string;
    message: {
      message_id: number;
      date: number;
      text?: string;
      from?: {
        id: number;
        is_bot?: boolean;
        first_name?: string;
        username?: string;
      };
      chat: {
        id: number;
        type: string;
        first_name?: string;
        last_name?: string;
        username?: string;
        is_forum?: boolean;
      };
      message_thread_id?: number;
    };
  };
};

type ScenarioContext = {
  chatId: string;
  inboundText: string;
  expectedReply: string;
  harness: MuxOpenClawHarness;
};

const OUTBOUND_TIMEOUT_MS = 60_000;
const OPENAI_TIMEOUT_MS = 30_000;
const PNG_FIXTURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0x99, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);
const OGG_FIXTURE = Uint8Array.from([
  0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x01, 0x1e, 0x01, 0x76, 0x6f, 0x72, 0x62, 0x69,
  0x73,
]);

export type TelegramMuxRoundTripScenario = {
  id: string;
  name: string;
  chatId: string;
  pairingRouteKey?: (chatId: string) => string;
  buildInboundUpdate: (params: { chatId: string; inboundText: string }) => Record<string, unknown>;
  claimSessionKey: (chatId: string) => string;
  expectedSessionKey?: (chatId: string) => string;
  openAiResponder: (params: {
    chatId: string;
    inboundText: string;
    expectedReply: string;
  }) => (request: FakeOpenAiRequest) => FakeOpenAiResponsePlan;
  workspaceFiles?: Record<string, string | Uint8Array>;
  assertOutbound: (params: ScenarioContext) => Promise<void>;
  assertOpenAi?: (params: ScenarioContext) => Promise<void>;
  assertSessionEntry?: (
    params: ScenarioContext & { sessionEntry: Record<string, unknown> },
  ) => void;
};

function loadFixture<T>(relativePath: string): T {
  return loadJsonFixture<T>(relativePath);
}

function buildTelegramDmTextUpdate(params: {
  chatId: string;
  inboundText: string;
}): Record<string, unknown> {
  const update = loadFixture<TelegramMessageUpdate>("telegram/inbound/dm-text.template.json");
  const chatId = Number(params.chatId);
  update.message.text = params.inboundText;
  update.message.from.id = chatId;
  update.message.chat.id = chatId;
  return update as unknown as Record<string, unknown>;
}

function buildTelegramGroupTextUpdate(params: {
  chatId: string;
  inboundText: string;
}): Record<string, unknown> {
  const update = loadFixture<TelegramMessageUpdate>("telegram/inbound/group-text.template.json");
  const chatId = Number(params.chatId);
  update.message.text = `@integration_bot ${params.inboundText}`;
  (
    update.message as TelegramMessageUpdate["message"] & {
      entities?: Array<{ type: string; offset: number; length: number }>;
    }
  ).entities = [{ type: "mention", offset: 0, length: 16 }];
  update.message.chat.id = chatId;
  return update as unknown as Record<string, unknown>;
}

function buildTelegramForumTopicTextUpdate(params: {
  chatId: string;
  inboundText: string;
}): Record<string, unknown> {
  const update = loadFixture<Record<string, unknown>>(
    "telegram/inbound/forum-topic-text.template.json",
  );
  const message = update.message as Record<string, unknown>;
  const chat = message.chat as Record<string, unknown>;
  message.text = `@integration_bot ${params.inboundText}`;
  message.entities = [{ type: "mention", offset: 0, length: 16 }];
  chat.id = Number(params.chatId);
  return update;
}

function buildTelegramDmReasoningCommandUpdate(params: {
  chatId: string;
}): Record<string, unknown> {
  const update = loadFixture<TelegramMessageUpdate>("telegram/inbound/dm-text.template.json");
  const chatId = Number(params.chatId);
  update.message.text = "/reasoning";
  update.message.from.id = chatId;
  update.message.chat.id = chatId;
  return update as unknown as Record<string, unknown>;
}

function buildTelegramDmModelsCommandUpdate(params: { chatId: string }): Record<string, unknown> {
  const update = loadFixture<TelegramMessageUpdate>("telegram/inbound/dm-text.template.json");
  const chatId = Number(params.chatId);
  update.message.text = "/models";
  update.message.from.id = chatId;
  update.message.chat.id = chatId;
  return update as unknown as Record<string, unknown>;
}

function buildTelegramDmCallbackQueryUpdate(params: {
  chatId: string;
  callbackData: string;
  updateId?: number;
  callbackMessageId?: number;
  callbackMessageText?: string;
}): Record<string, unknown> {
  const update = loadFixture<TelegramCallbackQueryUpdate>(
    "telegram/inbound/callback-query.template.json",
  );
  const chatId = Number(params.chatId);
  update.update_id = params.updateId ?? 700002;
  update.callback_query.data = params.callbackData;
  update.callback_query.from.id = chatId;
  update.callback_query.message.chat.id = chatId;
  update.callback_query.message.message_id = params.callbackMessageId ?? 900010;
  update.callback_query.message.text = params.callbackMessageText ?? "Choose an option";
  return update as unknown as Record<string, unknown>;
}

function assertDefaultTelegramSessionEntry(params: {
  chatId: string;
  sessionEntry: Record<string, unknown>;
}): void {
  if (params.sessionEntry.lastChannel !== "telegram") {
    throw new Error(
      `expected lastChannel=telegram, got ${String(params.sessionEntry.lastChannel)}`,
    );
  }
  if (params.sessionEntry.lastTo !== `telegram:${params.chatId}`) {
    throw new Error(
      `expected lastTo=telegram:${params.chatId}, got ${String(params.sessionEntry.lastTo)}`,
    );
  }
  if (params.sessionEntry.lastAccountId !== "default") {
    throw new Error(
      `expected lastAccountId=default, got ${String(params.sessionEntry.lastAccountId)}`,
    );
  }
}

function assertTelegramGroupSessionEntry(params: {
  chatId: string;
  sessionEntry: Record<string, unknown>;
}): void {
  assertDefaultTelegramSessionEntry(params);
  if (params.sessionEntry.lastTo !== `telegram:${params.chatId}`) {
    throw new Error(
      `expected lastTo=telegram:${params.chatId}, got ${String(params.sessionEntry.lastTo)}`,
    );
  }
}

function assertTelegramForumSessionEntry(params: {
  chatId: string;
  threadId: number;
  sessionEntry: Record<string, unknown>;
}): void {
  assertTelegramGroupSessionEntry(params);
  if (Number(params.sessionEntry.lastThreadId) !== params.threadId) {
    throw new Error(
      `expected lastThreadId=${params.threadId}, got ${String(params.sessionEntry.lastThreadId)}`,
    );
  }
}

function buildMessageToolArgs(params: {
  action: string;
  chatId: string;
  messageId?: string;
  emoji?: string;
  path?: string;
  message?: string;
  pollQuestion?: string;
  pollOption?: string[];
}): Record<string, unknown> {
  const args: Record<string, unknown> = {
    action: params.action,
    target: `telegram:${params.chatId}`,
  };
  if (params.messageId) {
    args.messageId = params.messageId;
  }
  if (params.emoji) {
    args.emoji = params.emoji;
  }
  if (params.path) {
    args.path = params.path;
  }
  if (params.message !== undefined) {
    args.message = params.message;
  }
  if (params.pollQuestion) {
    args.pollQuestion = params.pollQuestion;
  }
  if (params.pollOption) {
    args.pollOption = params.pollOption;
  }
  return args;
}

function buildStreamingReplyPlan(expectedReply: string) {
  const previewText = expectedReply.slice(0, 34);
  const remainder = expectedReply.slice(previewText.length);
  return streamingTextResponsePlan({
    text: expectedReply,
    deltas: [previewText, { text: remainder, delayMs: 50 }],
  });
}

async function assertPlainTextOutbound(params: ScenarioContext): Promise<void> {
  const outboundSend = await params.harness.telegram.waitForMethodCall(
    "sendMessage",
    (request) =>
      String(request.body.chat_id) === params.chatId &&
      String(request.body.text).includes(params.expectedReply),
    OUTBOUND_TIMEOUT_MS,
  );
  if (String(outboundSend.body.chat_id) !== params.chatId) {
    throw new Error(`expected sendMessage chat_id=${params.chatId}`);
  }
  if (!String(outboundSend.body.text).includes(params.expectedReply)) {
    throw new Error(`expected sendMessage text to contain ${params.expectedReply}`);
  }
}

async function assertStreamingTextPreviewAndFinalize(params: ScenarioContext): Promise<void> {
  const previewText = params.expectedReply.slice(0, 34);
  const preview = await params.harness.telegram.waitForMethodCall(
    "sendMessage",
    (request) =>
      String(request.body.chat_id) === params.chatId && String(request.body.text) === previewText,
    OUTBOUND_TIMEOUT_MS,
  );
  if (String(preview.body.chat_id) !== params.chatId) {
    throw new Error(`expected preview sendMessage chat_id=${params.chatId}`);
  }
  const finalEdit = await params.harness.telegram.waitForMethodCall(
    "editMessageText",
    (request) =>
      String(request.body.chat_id) === params.chatId &&
      Number(request.body.message_id) === 1000 &&
      String(request.body.text) === params.expectedReply,
    OUTBOUND_TIMEOUT_MS,
  );
  if (String(finalEdit.body.chat_id) !== params.chatId) {
    throw new Error(`expected final edit chat_id=${params.chatId}`);
  }
}

async function assertTypingThenStreamingTextPreviewAndFinalize(
  params: ScenarioContext,
  threadId?: number,
): Promise<void> {
  await assertStreamingTextPreviewAndFinalize(params);
  const previewText = params.expectedReply.slice(0, 34);
  const relevantRequests = params.harness.telegram.requests.filter(
    (request) =>
      ["sendChatAction", "sendMessage", "editMessageText"].includes(request.method) &&
      String(request.body.chat_id) === params.chatId,
  );
  const typingIndex = relevantRequests.findIndex(
    (request) =>
      request.method === "sendChatAction" &&
      String(request.body.action) === "typing" &&
      (threadId == null
        ? request.body.message_thread_id == null
        : Number(request.body.message_thread_id) === threadId),
  );
  const previewIndex = relevantRequests.findIndex(
    (request) =>
      request.method === "sendMessage" &&
      String(request.body.text) === previewText &&
      (threadId == null
        ? request.body.message_thread_id == null
        : Number(request.body.message_thread_id) === threadId),
  );

  if (typingIndex < 0) {
    throw new Error("expected sendChatAction typing before streaming preview");
  }
  if (previewIndex < 0) {
    throw new Error("expected streaming preview sendMessage");
  }
  if (typingIndex > previewIndex) {
    throw new Error("expected typing indicator before streaming preview sendMessage");
  }
}

async function assertDefaultOpenAiRequest(params: ScenarioContext): Promise<void> {
  const llmRequest = await params.harness.openai.waitForRequest(
    (request) => request.lastUserText.includes(params.inboundText),
    OPENAI_TIMEOUT_MS,
  );
  if (!llmRequest.lastUserText.includes(params.inboundText)) {
    throw new Error(`expected lastUserText to contain ${params.inboundText}`);
  }
}

async function assertNoOpenAiRequests(params: ScenarioContext): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 750));
  if (params.harness.openai.requests.length > 0) {
    throw new Error(`expected no OpenAI requests, got ${params.harness.openai.requests.length}`);
  }
}

export const TELEGRAM_MUX_ROUND_TRIP_SCENARIOS: TelegramMuxRoundTripScenario[] = [
  {
    id: "dm-text-legacy-binding",
    name: "Telegram DM with legacy transport session binding",
    chatId: "424242",
    buildInboundUpdate: buildTelegramDmTextUpdate,
    claimSessionKey: (chatId) => `agent:main:telegram:direct:${chatId}`,
    expectedSessionKey: () => "agent:main:main",
    openAiResponder: ({ expectedReply }) =>
      createSequentialResponseScript([{ type: "final_text", text: expectedReply }]),
    assertOutbound: assertPlainTextOutbound,
    assertOpenAi: assertDefaultOpenAiRequest,
    assertSessionEntry: ({ chatId, sessionEntry }) => {
      assertDefaultTelegramSessionEntry({ chatId, sessionEntry });
    },
  },
  {
    id: "dm-streaming-preview-final-edit",
    name: "Telegram DM streaming preview finalizes via edit",
    chatId: "424242",
    buildInboundUpdate: buildTelegramDmTextUpdate,
    claimSessionKey: (chatId) => `agent:main:telegram:direct:${chatId}`,
    expectedSessionKey: () => "agent:main:main",
    openAiResponder:
      ({ expectedReply }) =>
      () =>
        buildStreamingReplyPlan(expectedReply),
    assertOutbound: async (params) => {
      await assertTypingThenStreamingTextPreviewAndFinalize(params);
    },
    assertOpenAi: assertDefaultOpenAiRequest,
    assertSessionEntry: ({ chatId, sessionEntry }) => {
      assertDefaultTelegramSessionEntry({ chatId, sessionEntry });
    },
  },
  {
    id: "dm-react-via-message-tool",
    name: "Telegram DM reaction via message tool",
    chatId: "424242",
    buildInboundUpdate: buildTelegramDmTextUpdate,
    claimSessionKey: (chatId) => `agent:main:telegram:direct:${chatId}`,
    expectedSessionKey: () => "agent:main:main",
    openAiResponder: ({ chatId }) =>
      createSequentialResponseScript([
        {
          type: "tool_call",
          name: "message",
          callId: "call_react_1",
          args: buildMessageToolArgs({
            action: "react",
            chatId,
            messageId: "900001",
            emoji: "👍",
          }),
        },
        {
          type: "final_text",
          text: ({ toolOutputs }) => {
            if (!getFunctionCallOutput(toolOutputs, "call_react_1")) {
              throw new Error("missing message tool output for reaction script");
            }
            return "";
          },
        },
      ]),
    assertOutbound: async ({ harness, chatId }) => {
      const reaction = await harness.telegram.waitForMethodCall(
        "setMessageReaction",
        (request) =>
          String(request.body.chat_id) === chatId && String(request.body.message_id) === "900001",
        OUTBOUND_TIMEOUT_MS,
      );
      if (String(reaction.body.chat_id) !== chatId) {
        throw new Error(`expected reaction chat_id=${chatId}`);
      }
      if (String(reaction.body.message_id) !== "900001") {
        throw new Error("expected reaction message_id=900001");
      }
    },
    assertOpenAi: async ({ harness, inboundText }) => {
      await harness.openai.waitForRequest(
        (request) => request.lastUserText.includes(inboundText),
        OPENAI_TIMEOUT_MS,
      );
      const requests = await harness.openai.waitForRequestCount(2, OUTBOUND_TIMEOUT_MS);
      if (!requests[1]?.functionCallOutputs.length) {
        throw new Error("expected second OpenAI turn to include function_call_output");
      }
    },
    assertSessionEntry: ({ chatId, sessionEntry }) => {
      assertDefaultTelegramSessionEntry({ chatId, sessionEntry });
    },
  },
  {
    id: "dm-document-via-message-tool",
    name: "Telegram DM document send via message tool",
    chatId: "424242",
    buildInboundUpdate: buildTelegramDmTextUpdate,
    claimSessionKey: (chatId) => `agent:main:telegram:direct:${chatId}`,
    expectedSessionKey: () => "agent:main:main",
    workspaceFiles: {
      "fixtures/report.txt": "integration document payload\n",
    },
    openAiResponder: ({ chatId }) =>
      createSequentialResponseScript([
        {
          type: "tool_call",
          name: "message",
          callId: "call_document_1",
          args: buildMessageToolArgs({
            action: "send",
            chatId,
            path: "fixtures/report.txt",
            message: "report",
          }),
        },
        {
          type: "final_text",
          text: ({ toolOutputs }) => {
            if (!getFunctionCallOutput(toolOutputs, "call_document_1")) {
              throw new Error("missing message tool output for document script");
            }
            return "";
          },
        },
      ]),
    assertOutbound: async ({ harness, chatId }) => {
      const document = await harness.telegram.waitForMethodCall(
        "sendDocument",
        (request) => String(request.body.chat_id) === chatId,
        OUTBOUND_TIMEOUT_MS,
      );
      if (String(document.body.chat_id) !== chatId) {
        throw new Error(`expected document chat_id=${chatId}`);
      }
      if (document.body.document !== "<<multipart-file>>") {
        throw new Error("expected multipart document upload");
      }
      const caption = typeof document.body.caption === "string" ? document.body.caption : "";
      if (caption !== "report") {
        throw new Error("expected document caption to equal report");
      }
    },
    assertOpenAi: async ({ harness, inboundText }) => {
      await harness.openai.waitForRequest(
        (request) => request.lastUserText.includes(inboundText),
        OPENAI_TIMEOUT_MS,
      );
      await harness.openai.waitForRequestCount(2, OUTBOUND_TIMEOUT_MS);
    },
    assertSessionEntry: ({ chatId, sessionEntry }) => {
      assertDefaultTelegramSessionEntry({ chatId, sessionEntry });
    },
  },
  {
    id: "dm-photo-via-message-tool",
    name: "Telegram DM photo send via message tool",
    chatId: "424242",
    buildInboundUpdate: buildTelegramDmTextUpdate,
    claimSessionKey: (chatId) => `agent:main:telegram:direct:${chatId}`,
    expectedSessionKey: () => "agent:main:main",
    workspaceFiles: {
      "fixtures/pixel.png": PNG_FIXTURE,
    },
    openAiResponder: ({ chatId }) =>
      createSequentialResponseScript([
        {
          type: "tool_call",
          name: "message",
          callId: "call_photo_1",
          args: buildMessageToolArgs({
            action: "send",
            chatId,
            path: "fixtures/pixel.png",
            message: "photo caption",
          }),
        },
        {
          type: "final_text",
          text: ({ toolOutputs }) => {
            if (!getFunctionCallOutput(toolOutputs, "call_photo_1")) {
              throw new Error("missing message tool output for photo script");
            }
            return "";
          },
        },
      ]),
    assertOutbound: async ({ harness, chatId }) => {
      const photo = await harness.telegram.waitForMethodCall(
        "sendPhoto",
        (request) => String(request.body.chat_id) === chatId,
        OUTBOUND_TIMEOUT_MS,
      );
      if (String(photo.body.chat_id) !== chatId) {
        throw new Error(`expected photo chat_id=${chatId}`);
      }
      if (photo.body.photo !== "<<multipart-file>>") {
        throw new Error("expected multipart photo upload");
      }
      const caption = typeof photo.body.caption === "string" ? photo.body.caption : "";
      if (caption !== "photo caption") {
        throw new Error("expected photo caption to equal photo caption");
      }
    },
    assertOpenAi: async ({ harness, inboundText }) => {
      await harness.openai.waitForRequest(
        (request) => request.lastUserText.includes(inboundText),
        OPENAI_TIMEOUT_MS,
      );
      await harness.openai.waitForRequestCount(2, OUTBOUND_TIMEOUT_MS);
    },
    assertSessionEntry: ({ chatId, sessionEntry }) => {
      assertDefaultTelegramSessionEntry({ chatId, sessionEntry });
    },
  },
  {
    id: "dm-voice-via-message-tool",
    name: "Telegram DM voice send via message tool",
    chatId: "424242",
    buildInboundUpdate: buildTelegramDmTextUpdate,
    claimSessionKey: (chatId) => `agent:main:telegram:direct:${chatId}`,
    expectedSessionKey: () => "agent:main:main",
    workspaceFiles: {
      "fixtures/note.ogg": OGG_FIXTURE,
    },
    openAiResponder: ({ chatId }) =>
      createSequentialResponseScript([
        {
          type: "tool_call",
          name: "message",
          callId: "call_voice_1",
          args: {
            ...buildMessageToolArgs({
              action: "send",
              chatId,
              path: "fixtures/note.ogg",
              message: "voice note",
            }),
            asVoice: true,
          },
        },
        {
          type: "final_text",
          text: ({ toolOutputs }) => {
            if (!getFunctionCallOutput(toolOutputs, "call_voice_1")) {
              throw new Error("missing message tool output for voice script");
            }
            return "";
          },
        },
      ]),
    assertOutbound: async ({ harness, chatId }) => {
      const voice = await harness.telegram.waitForMethodCall(
        "sendVoice",
        (request) => String(request.body.chat_id) === chatId,
        OUTBOUND_TIMEOUT_MS,
      );
      if (String(voice.body.chat_id) !== chatId) {
        throw new Error(`expected voice chat_id=${chatId}`);
      }
      if (voice.body.voice !== "<<multipart-file>>") {
        throw new Error("expected multipart voice upload");
      }
      const caption = typeof voice.body.caption === "string" ? voice.body.caption : "";
      if (caption !== "voice note") {
        throw new Error("expected voice caption to equal voice note");
      }
    },
    assertOpenAi: async ({ harness, inboundText }) => {
      await harness.openai.waitForRequest(
        (request) => request.lastUserText.includes(inboundText),
        OPENAI_TIMEOUT_MS,
      );
      await harness.openai.waitForRequestCount(2, OUTBOUND_TIMEOUT_MS);
    },
    assertSessionEntry: ({ chatId, sessionEntry }) => {
      assertDefaultTelegramSessionEntry({ chatId, sessionEntry });
    },
  },
  {
    id: "dm-react-document-text-sequential",
    name: "Telegram DM reaction, document, and final text in sequence",
    chatId: "424242",
    buildInboundUpdate: buildTelegramDmTextUpdate,
    claimSessionKey: (chatId) => `agent:main:telegram:direct:${chatId}`,
    expectedSessionKey: () => "agent:main:main",
    workspaceFiles: {
      "fixtures/report.txt": "integration document payload\n",
    },
    openAiResponder: ({ chatId, expectedReply }) =>
      createSequentialResponseScript([
        {
          type: "tool_call",
          name: "message",
          callId: "call_react_seq_1",
          args: buildMessageToolArgs({
            action: "react",
            chatId,
            messageId: "900001",
            emoji: "👍",
          }),
        },
        {
          type: "tool_call",
          name: "message",
          callId: "call_document_seq_1",
          args: ({ toolOutputs }) => {
            if (!getFunctionCallOutput(toolOutputs, "call_react_seq_1")) {
              throw new Error("missing reaction tool output for sequential script");
            }
            return buildMessageToolArgs({
              action: "send",
              chatId,
              path: "fixtures/report.txt",
              message: "CONFIRMED_FILE",
            });
          },
        },
        {
          type: "final_text",
          text: ({ toolOutputs }) => {
            if (!getFunctionCallOutput(toolOutputs, "call_document_seq_1")) {
              throw new Error("missing document tool output for sequential script");
            }
            return expectedReply;
          },
        },
      ]),
    assertOutbound: async ({ harness, chatId, expectedReply }) => {
      const reaction = await harness.telegram.waitForMethodCall(
        "setMessageReaction",
        (request) =>
          String(request.body.chat_id) === chatId && String(request.body.message_id) === "900001",
        OUTBOUND_TIMEOUT_MS,
      );
      if (String(reaction.body.chat_id) !== chatId) {
        throw new Error(`expected reaction chat_id=${chatId}`);
      }
      const document = await harness.telegram.waitForMethodCall(
        "sendDocument",
        (request) => String(request.body.chat_id) === chatId,
        OUTBOUND_TIMEOUT_MS,
      );
      if (document.body.document !== "<<multipart-file>>") {
        throw new Error("expected multipart document upload");
      }
      const caption = typeof document.body.caption === "string" ? document.body.caption : "";
      if (caption !== "CONFIRMED_FILE") {
        throw new Error("expected document caption to equal CONFIRMED_FILE");
      }
      const outboundSend = await harness.telegram.waitForMethodCall(
        "sendMessage",
        (request) =>
          String(request.body.chat_id) === chatId &&
          String(request.body.text).includes(expectedReply),
        OUTBOUND_TIMEOUT_MS,
      );
      if (!String(outboundSend.body.text).includes(expectedReply)) {
        throw new Error(`expected sendMessage text to contain ${expectedReply}`);
      }
    },
    assertOpenAi: async ({ harness, inboundText, expectedReply }) => {
      await harness.openai.waitForRequest(
        (request) => request.lastUserText.includes(inboundText),
        OPENAI_TIMEOUT_MS,
      );
      const requests = await harness.openai.waitForRequestCount(3, OUTBOUND_TIMEOUT_MS);
      if (
        !requests[2]?.allFunctionCallOutputs.find((entry) => entry.callId === "call_react_seq_1")
      ) {
        throw new Error("expected third OpenAI turn to retain reaction output context");
      }
      if (
        !requests[2]?.allFunctionCallOutputs.find((entry) => entry.callId === "call_document_seq_1")
      ) {
        throw new Error("expected third OpenAI turn to retain document output context");
      }
      if (requests[2]?.lastUserText && requests[2].lastUserText.includes(expectedReply)) {
        throw new Error("final assistant text should not appear as user input");
      }
    },
    assertSessionEntry: ({ chatId, sessionEntry }) => {
      assertDefaultTelegramSessionEntry({ chatId, sessionEntry });
    },
  },
  {
    id: "group-text-legacy-binding",
    name: "Telegram group with legacy transport session binding",
    chatId: "-100555",
    pairingRouteKey: (chatId) => `telegram:default:chat:${chatId}`,
    buildInboundUpdate: buildTelegramGroupTextUpdate,
    claimSessionKey: (chatId) => `agent:main:telegram:group:${chatId}`,
    expectedSessionKey: (chatId) => `agent:main:telegram:group:${chatId}`,
    openAiResponder: ({ expectedReply }) =>
      createSequentialResponseScript([{ type: "final_text", text: expectedReply }]),
    assertOutbound: assertPlainTextOutbound,
    assertOpenAi: assertDefaultOpenAiRequest,
    assertSessionEntry: ({ chatId, sessionEntry }) => {
      assertTelegramGroupSessionEntry({ chatId, sessionEntry });
    },
  },
  {
    id: "dm-reasoning-command-menu",
    name: "Telegram DM /reasoning renders inline button menu",
    chatId: "424242",
    buildInboundUpdate: ({ chatId }) => buildTelegramDmReasoningCommandUpdate({ chatId }),
    claimSessionKey: (chatId) => `agent:main:telegram:direct:${chatId}`,
    openAiResponder: () => createSequentialResponseScript([{ type: "final_text", text: "" }]),
    assertOutbound: async ({ harness, chatId }) => {
      const outboundSend = await harness.telegram.waitForMethodCall(
        "sendMessage",
        (request) =>
          String(request.body.chat_id) === chatId &&
          typeof request.body.reply_markup === "object" &&
          request.body.reply_markup !== null,
        OUTBOUND_TIMEOUT_MS,
      );
      const replyMarkup = outboundSend.body.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string; text?: string }>>;
      };
      const callbackData = new Set(
        (replyMarkup.inline_keyboard ?? [])
          .flat()
          .map((button) => button.callback_data)
          .filter((value): value is string => typeof value === "string"),
      );
      if (!callbackData.has("/reasoning on")) {
        throw new Error("expected /reasoning on button");
      }
      if (!callbackData.has("/reasoning off")) {
        throw new Error("expected /reasoning off button");
      }
      if (!callbackData.has("/reasoning stream")) {
        throw new Error("expected /reasoning stream button");
      }
    },
    assertOpenAi: assertNoOpenAiRequests,
  },
  {
    id: "forum-topic-text-legacy-binding",
    name: "Telegram forum topic with legacy transport session binding",
    chatId: "-100777",
    pairingRouteKey: (chatId) => `telegram:default:chat:${chatId}:topic:2`,
    buildInboundUpdate: buildTelegramForumTopicTextUpdate,
    claimSessionKey: (chatId) => `agent:main:telegram:group:${chatId}:topic:2`,
    expectedSessionKey: (chatId) => `agent:main:telegram:group:${chatId}:topic:2`,
    openAiResponder: ({ expectedReply }) =>
      createSequentialResponseScript([{ type: "final_text", text: expectedReply }]),
    assertOutbound: async ({ harness, chatId, expectedReply }) => {
      const outboundSend = await harness.telegram.waitForMethodCall(
        "sendMessage",
        (request) =>
          String(request.body.chat_id) === chatId &&
          String(request.body.text).includes(expectedReply) &&
          Number(request.body.message_thread_id) === 2,
        OUTBOUND_TIMEOUT_MS,
      );
      if (Number(outboundSend.body.message_thread_id) !== 2) {
        throw new Error("expected sendMessage message_thread_id=2");
      }
    },
    assertOpenAi: assertDefaultOpenAiRequest,
    assertSessionEntry: ({ chatId, sessionEntry }) => {
      assertTelegramForumSessionEntry({ chatId, threadId: 2, sessionEntry });
    },
  },
  {
    id: "forum-topic-streaming-preview-final-edit",
    name: "Telegram forum topic typing precedes streaming preview and final edit",
    chatId: "-100777",
    pairingRouteKey: (chatId) => `telegram:default:chat:${chatId}:topic:2`,
    buildInboundUpdate: buildTelegramForumTopicTextUpdate,
    claimSessionKey: (chatId) => `agent:main:telegram:group:${chatId}:topic:2`,
    expectedSessionKey: (chatId) => `agent:main:telegram:group:${chatId}:topic:2`,
    openAiResponder:
      ({ expectedReply }) =>
      () =>
        buildStreamingReplyPlan(expectedReply),
    assertOutbound: async (params) => {
      await assertTypingThenStreamingTextPreviewAndFinalize(params, 2);
    },
    assertOpenAi: assertDefaultOpenAiRequest,
    assertSessionEntry: ({ chatId, sessionEntry }) => {
      assertTelegramForumSessionEntry({ chatId, threadId: 2, sessionEntry });
    },
  },
  {
    id: "dm-models-callback-edit",
    name: "Telegram DM /models callback edits the original message with model buttons",
    chatId: "424242",
    buildInboundUpdate: ({ chatId }) => buildTelegramDmModelsCommandUpdate({ chatId }),
    claimSessionKey: (chatId) => `agent:main:telegram:direct:${chatId}`,
    openAiResponder: () => createSequentialResponseScript([{ type: "final_text", text: "" }]),
    assertOutbound: async ({ harness, chatId }) => {
      const initialSend = await harness.telegram.waitForMethodCall(
        "sendMessage",
        (request) =>
          String(request.body.chat_id) === chatId &&
          String(request.body.text).includes("Select a provider"),
        OUTBOUND_TIMEOUT_MS,
      );
      const initialReplyMarkup = initialSend.body.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string; text?: string }>>;
      };
      const initialCallbackData = (initialReplyMarkup.inline_keyboard ?? [])
        .flat()
        .map((button) => button.callback_data)
        .filter((value): value is string => typeof value === "string");
      if (!initialCallbackData.includes("mdl_list_openai_1")) {
        throw new Error("expected initial /models provider button for openai");
      }
      harness.telegram.enqueueUpdate(
        buildTelegramDmCallbackQueryUpdate({
          chatId,
          updateId: 700002,
          callbackData: "mdl_list_openai_1",
          callbackMessageId: 1000,
          callbackMessageText:
            typeof initialSend.body.text === "string"
              ? initialSend.body.text
              : "Select a provider:",
        }),
      );
      const callbackAnswer = await harness.telegram.waitForMethodCall(
        "answerCallbackQuery",
        (request) => String(request.body.callback_query_id) === "cbq-900010",
        OUTBOUND_TIMEOUT_MS,
      );
      if (String(callbackAnswer.body.callback_query_id) !== "cbq-900010") {
        throw new Error("expected callback query acknowledgement");
      }
      const edit = await harness.telegram.waitForMethodCall(
        "editMessageText",
        (request) =>
          String(request.body.chat_id) === chatId &&
          Number(request.body.message_id) === 1000 &&
          String(request.body.text).includes("Models (openai)"),
        OUTBOUND_TIMEOUT_MS,
      );
      const replyMarkup = edit.body.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string; text?: string }>>;
      };
      const callbackData = (replyMarkup.inline_keyboard ?? [])
        .flat()
        .map((button) => button.callback_data)
        .filter((value): value is string => typeof value === "string");
      if (!callbackData.some((value) => value.startsWith("mdl_sel_openai/"))) {
        throw new Error("expected model selection buttons after callback edit");
      }
    },
    assertOpenAi: assertNoOpenAiRequests,
  },
];
