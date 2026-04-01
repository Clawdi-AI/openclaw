import { describe, expect, test } from "vitest";
import { readChannelAllowFromStoreSync } from "../../src/pairing/pairing-store.js";
import { createSequentialResponseScript, getFunctionCallOutput } from "./fake-openai.js";
import { withMuxOpenClawHarness } from "./mux-openclaw-harness.js";
import { waitForCondition } from "./test-utils.js";

describe("mux Discord exec approvals", () => {
  test.each(["session-first", "target-first"] as const)(
    "delivers an exec approval prompt to the paired Discord approver in %s mode",
    async (resolutionMode) => {
      const userId = "4242";
      const channelId = "3001";
      const inboundText = `run exec requiring approval ${resolutionMode}`;
      const command = `echo discord-approval-${resolutionMode}`;

      await withMuxOpenClawHarness(
        {
          channel: "discord",
          chatId: userId,
          claimedSessionKey: `dc:dm:${userId}`,
          skipInitialClaim: true,
          llmReplyText: "",
          resolutionMode,
          minimalGateway: false,
          discordGatewayDmEnabled: true,
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
                    throw new Error("missing exec tool output for Discord approval script");
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
              discord: {
                ...cfg.channels?.discord,
                execApprovals: {
                  enabled: true,
                  target: "dm",
                },
              },
            },
          }),
        },
        async (harness) => {
          const discord = harness.discord;
          expect(discord).toBeDefined();
          if (!discord) {
            throw new Error("discord harness not available");
          }

          discord.registerDmChannel(userId, channelId);
          const pairingToken = await harness.issuePairingToken({
            sessionKey: `dc:dm:${userId}`,
          });
          discord.enqueueDmMessage({
            userId,
            channelId,
            messageId: "8999",
            content: `/bot_switch ${pairingToken}`,
            timestamp: "2026-01-01T00:00:00.000Z",
            username: "discord-user",
          });
          await waitForCondition(
            () => {
              const allowFrom = readChannelAllowFromStoreSync("discord", process.env, "default");
              return allowFrom.includes(userId) ? allowFrom : undefined;
            },
            20_000,
            "timed out waiting for Discord mux post-pair bootstrap",
          );
          await waitForCondition(
            () => (harness.openai.requests.length >= 1 ? harness.openai.requests : undefined),
            20_000,
            "timed out waiting for Discord post-pair synthetic turn",
          );

          discord.enqueueDmMessage({
            userId,
            channelId,
            messageId: "9001",
            content: inboundText,
            timestamp: "2026-01-01T00:00:00.000Z",
            username: "discord-user",
          });

          await harness.openai.waitForRequest(
            (request) => request.lastUserText.includes(inboundText),
            20_000,
          );

          const muxLogs = await waitForCondition(
            () => {
              const logs = harness.readRecentLogs().muxServer;
              return logs.includes("Approval required.") && logs.includes(command)
                ? logs
                : undefined;
            },
            20_000,
            "timed out waiting for Discord mux approval prompt delivery",
          );
          expect(muxLogs).toContain('"type":"outbound_request"');
          expect(muxLogs).toContain("/approve");

          const sessionEntry = await harness.waitForSessionStoreEntry("agent:main:main");
          expect(sessionEntry).toMatchObject({
            lastChannel: "discord",
            lastTo: `user:${userId}`,
          });
        },
      );
    },
    60_000,
  );
});
