import type { FakeOpenAiRequest, FakeOpenAiResponsePlan } from "./fake-openai.js";
import { createSequentialResponseScript, getFunctionCallOutput } from "./fake-openai.js";
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

type ScenarioContext = {
  chatId: string;
  inboundText: string;
  expectedReply: string;
  harness: MuxOpenClawHarness;
};

const OUTBOUND_TIMEOUT_MS = 60_000;
const OPENAI_TIMEOUT_MS = 30_000;

export type TelegramMuxRoundTripScenario = {
  id: string;
  name: string;
  chatId: string;
  pairingRouteKey?: (chatId: string) => string;
  buildInboundUpdate: (params: { chatId: string; inboundText: string }) => Record<string, unknown>;
  claimSessionKey: (chatId: string) => string;
  expectedSessionKey: (chatId: string) => string;
  openAiResponder: (params: {
    chatId: string;
    inboundText: string;
    expectedReply: string;
  }) => (request: FakeOpenAiRequest) => FakeOpenAiResponsePlan;
  workspaceFiles?: Record<string, string | Uint8Array>;
  assertOutbound: (params: ScenarioContext) => Promise<void>;
  assertOpenAi?: (params: ScenarioContext) => Promise<void>;
  assertSessionEntry: (params: ScenarioContext & { sessionEntry: Record<string, unknown> }) => void;
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

async function assertDefaultOpenAiRequest(params: ScenarioContext): Promise<void> {
  const llmRequest = await params.harness.openai.waitForRequest(
    (request) => request.lastUserText.includes(params.inboundText),
    OPENAI_TIMEOUT_MS,
  );
  if (!llmRequest.lastUserText.includes(params.inboundText)) {
    throw new Error(`expected lastUserText to contain ${params.inboundText}`);
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
];
