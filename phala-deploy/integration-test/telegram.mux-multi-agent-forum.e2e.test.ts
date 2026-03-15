import { describe, expect, test } from "vitest";
import { withMuxOpenClawHarness } from "./mux-openclaw-harness.js";

function buildForumUpdate(params: {
  chatId: string;
  text: string;
  updateId: number;
  messageId: number;
  topicId?: number;
}): Record<string, unknown> {
  return {
    update_id: params.updateId,
    message: {
      message_id: params.messageId,
      from: {
        id: 424242,
        is_bot: false,
        first_name: "Mux",
        username: "mux_user",
      },
      chat: {
        id: Number(params.chatId),
        title: "Integration Forum",
        is_forum: true,
        type: "supergroup",
      },
      date: 1_700_000_002,
      ...(params.topicId != null ? { message_thread_id: params.topicId } : {}),
      text: params.text,
      is_topic_message: true,
    },
  };
}

describe("mux Telegram multi-agent forum", () => {
  test.each(["session-first", "target-first"] as const)(
    "routes General to main and sales topic to sales in %s mode",
    async (resolutionMode) => {
      const forumChatId = "-100777";
      const generalReply = `MAIN_FORUM_OK_${resolutionMode}`;
      const salesReply = `SALES_FORUM_OK_${resolutionMode}`;
      const generalText = `general topic ${resolutionMode}`;
      const salesText = `sales topic ${resolutionMode}`;

      await withMuxOpenClawHarness(
        {
          chatId: forumChatId,
          claimedSessionKey: `agent:main:telegram:group:${forumChatId}:topic:1`,
          pairingRouteKey: `telegram:default:chat:${forumChatId}`,
          llmReplyText: "unused",
          resolutionMode,
          minimalGateway: false,
          configTransform: (cfg) => ({
            ...cfg,
            channels: {
              ...cfg.channels,
              telegram: {
                ...cfg.channels?.telegram,
                groups: {
                  ...cfg.channels?.telegram?.groups,
                  "*": { requireMention: false },
                },
              },
            },
            agents: {
              ...cfg.agents,
              list: [{ id: "main", default: true }, { id: "sales" }],
            },
            bindings: [
              {
                agentId: "sales",
                match: {
                  channel: "telegram",
                  peer: { kind: "group", id: `${forumChatId}:topic:2` },
                },
              },
              {
                agentId: "main",
                match: {
                  channel: "telegram",
                  peer: { kind: "group", id: forumChatId },
                },
              },
            ],
          }),
          openAiResponder: (request) => {
            if (request.lastUserText.includes(generalText)) {
              return generalReply;
            }
            if (request.lastUserText.includes(salesText)) {
              return salesReply;
            }
            throw new Error(`unexpected forum request: ${request.lastUserText}`);
          },
        },
        async (harness) => {
          harness.telegram.enqueueUpdate(
            buildForumUpdate({
              chatId: forumChatId,
              text: generalText,
              updateId: 700201,
              messageId: 900201,
            }),
          );

          await harness.openai.waitForRequest(
            (request) => request.lastUserText.includes(generalText),
            20_000,
          );
          const generalSend = await harness.telegram.waitForMethodCall(
            "sendMessage",
            (request) =>
              String(request.body.chat_id) === forumChatId &&
              String(request.body.text).includes(generalReply),
            30_000,
          );
          expect(generalSend.body.message_thread_id).toBeUndefined();

          await harness.waitForSessionStoreEntry(
            `agent:main:telegram:group:${forumChatId}:topic:1`,
            "main",
          );
          expect(
            harness.readSessionStore("sales")[`agent:sales:telegram:group:${forumChatId}:topic:2`],
          ).toBeUndefined();

          harness.telegram.enqueueUpdate(
            buildForumUpdate({
              chatId: forumChatId,
              text: salesText,
              updateId: 700202,
              messageId: 900202,
              topicId: 2,
            }),
          );

          await harness.openai.waitForRequest(
            (request) => request.lastUserText.includes(salesText),
            20_000,
          );
          const salesSend = await harness.telegram.waitForMethodCall(
            "sendMessage",
            (request) =>
              String(request.body.chat_id) === forumChatId &&
              String(request.body.text).includes(salesReply),
            30_000,
          );
          expect(Number(salesSend.body.message_thread_id)).toBe(2);

          await harness.waitForSessionStoreEntry(
            `agent:sales:telegram:group:${forumChatId}:topic:2`,
            "sales",
          );
          expect(
            harness.readSessionStore("main")[`agent:sales:telegram:group:${forumChatId}:topic:2`],
          ).toBeUndefined();
          expect(harness.openai.requests).toHaveLength(2);
        },
      );
    },
    120_000,
  );
});
