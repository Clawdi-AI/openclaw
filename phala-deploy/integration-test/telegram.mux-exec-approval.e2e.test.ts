import { describe, expect, test } from "vitest";
import { readChannelAllowFromStoreSync } from "../../src/pairing/pairing-store.js";
import { createSequentialResponseScript, getFunctionCallOutput } from "./fake-openai.js";
import { withMuxOpenClawHarness } from "./mux-openclaw-harness.js";
import { waitForCondition } from "./test-utils.js";

function buildTelegramDmTextUpdate(params: {
  chatId: string;
  inboundText: string;
  sequence: number;
}) {
  return {
    update_id: 9_000_000 + params.sequence,
    message: {
      message_id: 9_000 + params.sequence,
      date: 1_704_067_200,
      text: params.inboundText,
      from: {
        id: Number(params.chatId),
        is_bot: false,
        first_name: "Mux",
        username: "mux_user",
      },
      chat: {
        id: Number(params.chatId),
        type: "private",
        first_name: "Mux",
        username: "mux_user",
      },
    },
  };
}

describe("mux Telegram exec approvals", () => {
  test.each(["session-first", "target-first"] as const)(
    "delivers an exec approval prompt to the paired Telegram approver in %s mode",
    async (resolutionMode) => {
      const chatId = "424242";
      const inboundText = `run exec requiring approval ${resolutionMode}`;
      const command = `echo telegram-approval-${resolutionMode}`;

      await withMuxOpenClawHarness(
        {
          channel: "telegram",
          chatId,
          claimedSessionKey: `agent:main:telegram:direct:${chatId}`,
          skipInitialClaim: true,
          llmReplyText: "",
          resolutionMode,
          minimalGateway: false,
          openAiResponder: (request) => {
            if (!request.lastUserText.includes(inboundText)) {
              return "";
            }
            return createSequentialResponseScript([
              {
                type: "tool_call",
                name: "exec",
                callId: "call_exec_1",
                args: { command },
              },
              {
                type: "final_text",
                text: ({ toolOutputs }) => {
                  if (!getFunctionCallOutput(toolOutputs, "call_exec_1")) {
                    throw new Error("missing exec tool output for Telegram approval script");
                  }
                  return "";
                },
              },
            ])(request);
          },
          configTransform: (cfg) => ({
            ...cfg,
            tools: {
              ...cfg.tools,
              exec: {
                ...cfg.tools?.exec,
                host: "gateway",
                security: "full",
                ask: "always",
              },
            },
            channels: {
              ...cfg.channels,
              telegram: {
                ...cfg.channels?.telegram,
                execApprovals: {
                  enabled: true,
                  target: "dm",
                },
              },
            },
          }),
        },
        async (harness) => {
          const telegram = harness.telegram;
          expect(telegram).toBeDefined();
          if (!telegram) {
            throw new Error("telegram harness not available");
          }

          const pairingToken = await harness.issuePairingToken({
            sessionKey: `agent:main:telegram:direct:${chatId}`,
          });
          telegram.enqueueUpdate(
            buildTelegramDmTextUpdate({
              chatId,
              inboundText: `/start ${pairingToken}`,
              sequence: 1,
            }),
          );
          await waitForCondition(
            () => {
              const allowFrom = readChannelAllowFromStoreSync("telegram", process.env, "default");
              return allowFrom.includes(chatId) ? allowFrom : undefined;
            },
            20_000,
            "timed out waiting for Telegram mux post-pair bootstrap",
          );
          await waitForCondition(
            () => (harness.openai.requests.length >= 1 ? harness.openai.requests : undefined),
            20_000,
            "timed out waiting for Telegram post-pair synthetic turn",
          );

          telegram.enqueueUpdate(
            buildTelegramDmTextUpdate({
              chatId,
              inboundText,
              sequence: 2,
            }),
          );

          await harness.openai.waitForRequest(
            (request) => request.lastUserText.includes(inboundText),
            30_000,
          );

          await telegram.waitForMethodCall(
            "sendMessage",
            (request) =>
              String(request.body.chat_id) === chatId &&
              String(request.body.text).includes("Approval required.") &&
              String(request.body.text).includes(command) &&
              String(request.body.text).includes("/approve"),
            20_000,
          );

          const sessionEntry = await harness.waitForSessionStoreEntry("agent:main:main");
          expect(sessionEntry).toMatchObject({
            lastChannel: "telegram",
            lastTo: `telegram:${chatId}`,
            lastAccountId: "default",
          });
        },
      );
    },
    60_000,
  );
});
