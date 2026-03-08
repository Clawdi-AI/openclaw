import { describe, expect, test } from "vitest";
import { withMuxOpenClawHarness } from "./mux-openclaw-harness.js";

describe("Discord mux round trip", () => {
  test.each(["session-first", "target-first"] as const)(
    "round-trips a Discord DM in %s mode",
    async (resolutionMode) => {
      const userId = "4242";
      const channelId = "3001";
      const inboundText = `hello from discord ${resolutionMode}`;
      const expectedReply = `DISCORD_OK_${resolutionMode}`;

      await withMuxOpenClawHarness(
        {
          channel: "discord",
          chatId: userId,
          claimedSessionKey: `dc:dm:${userId}`,
          llmReplyText: expectedReply,
          resolutionMode,
          minimalGateway: false,
        },
        async (harness) => {
          expect(harness.discord).toBeDefined();
          const discord = harness.discord;
          if (!discord) {
            throw new Error("discord harness not available");
          }

          discord.registerDmChannel(userId, channelId);
          discord.enqueueDmMessage({
            userId,
            channelId,
            messageId: "9001",
            content: inboundText,
            timestamp: "2026-01-01T00:00:00.000Z",
            username: "discord-user",
          });

          const dmCreate = await discord.waitForRequest(
            (request) => request.kind === "createDmChannel" && request.userId === userId,
            10_000,
          );
          expect(dmCreate).toMatchObject({
            kind: "createDmChannel",
            userId,
          });

          await harness.openai.waitForRequest(
            (request) => request.lastUserText.includes(inboundText),
            10_000,
          );

          const typing = await discord
            .waitForRequest(
              (request) => request.kind === "typing" && request.channelId === channelId,
              10_000,
            )
            .catch((error) => {
              const logs = harness.readRecentLogs();
              throw new Error(
                `${String(error)}\n--- gateway ---\n${logs.gateway}\n--- mux ---\n${logs.muxServer}`,
              );
            });
          const outbound = await discord
            .waitForRequest(
              (request) =>
                request.kind === "sendMessage" &&
                request.channelId === channelId &&
                request.body.content === expectedReply,
              10_000,
            )
            .catch((error) => {
              const logs = harness.readRecentLogs();
              throw new Error(
                `${String(error)}\n--- gateway ---\n${logs.gateway}\n--- mux ---\n${logs.muxServer}`,
              );
            });

          const typingIndex = discord.requests.indexOf(typing);
          const outboundIndex = discord.requests.indexOf(outbound);
          expect(typingIndex).toBeGreaterThanOrEqual(0);
          expect(outboundIndex).toBeGreaterThan(typingIndex);

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
