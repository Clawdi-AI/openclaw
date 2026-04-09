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

  test.each(["session-first", "target-first"] as const)(
    "round-trips a Discord guild channel in %s mode",
    async (resolutionMode) => {
      const guildId = "9001";
      const channelId = "777001";
      const userId = "4242";
      const inboundText = `hello from discord guild ${resolutionMode}`;
      const expectedReply = `DISCORD_GUILD_OK_${resolutionMode}`;

      await withMuxOpenClawHarness(
        {
          channel: "discord",
          chatId: guildId,
          claimedSessionKey: `agent:main:discord:channel:${channelId}`,
          pairingRouteKey: `discord:default:guild:${guildId}`,
          llmReplyText: expectedReply,
          resolutionMode,
          minimalGateway: false,
          discordGatewayGuildEnabled: true,
        },
        async (harness) => {
          const discord = harness.discord;
          expect(discord).toBeDefined();
          if (!discord) {
            throw new Error("discord harness not available");
          }

          discord.registerGuildChannel({ guildId, channelId });
          // Include bot in mentions so the message passes requireMention gating.
          discord.enqueueGuildMessage({
            guildId,
            channelId,
            messageId: "9101",
            content: `<@${discord.botUserId}> ${inboundText}`,
            authorId: userId,
            username: "guild-user",
            mentions: [{ id: discord.botUserId, username: "integration-bot", bot: true }],
          });

          await harness.openai.waitForRequest(
            (request) => request.lastUserText.includes(inboundText),
            10_000,
          );

          const typing = await discord.waitForRequest(
            (request) => request.kind === "typing" && request.channelId === channelId,
            10_000,
          );
          const outbound = await discord.waitForRequest(
            (request) =>
              request.kind === "sendMessage" &&
              request.channelId === channelId &&
              request.body.content === expectedReply,
            10_000,
          );

          expect(discord.requests.indexOf(outbound)).toBeGreaterThan(
            discord.requests.indexOf(typing),
          );

          const sessionEntry = await harness.waitForSessionStoreEntry(
            `agent:main:discord:channel:${channelId}`,
          );
          expect(sessionEntry).toMatchObject({
            lastChannel: "discord",
            lastTo: `channel:${channelId}`,
          });
        },
      );
    },
    60_000,
  );

  test.each(["session-first", "target-first"] as const)(
    "round-trips a Discord thread in %s mode",
    async (resolutionMode) => {
      const guildId = "9001";
      const parentChannelId = "777001";
      const threadId = "777101";
      const userId = "4242";
      const inboundText = `hello from discord thread ${resolutionMode}`;
      const expectedReply = `DISCORD_THREAD_OK_${resolutionMode}`;

      await withMuxOpenClawHarness(
        {
          channel: "discord",
          chatId: guildId,
          claimedSessionKey: `agent:main:discord:channel:${threadId}`,
          pairingRouteKey: `discord:default:guild:${guildId}`,
          llmReplyText: expectedReply,
          resolutionMode,
          minimalGateway: false,
          discordGatewayGuildEnabled: true,
        },
        async (harness) => {
          const discord = harness.discord;
          expect(discord).toBeDefined();
          if (!discord) {
            throw new Error("discord harness not available");
          }

          discord.registerGuildChannel({ guildId, channelId: parentChannelId });
          discord.registerThread({
            guildId,
            threadId,
            parentId: parentChannelId,
          });
          discord.enqueueGuildMessage({
            guildId,
            channelId: threadId,
            messageId: "9201",
            content: `<@${discord.botUserId}> ${inboundText}`,
            authorId: userId,
            username: "thread-user",
            mentions: [{ id: discord.botUserId, username: "integration-bot", bot: true }],
          });

          await harness.openai.waitForRequest(
            (request) => request.lastUserText.includes(inboundText),
            10_000,
          );

          const typing = await discord.waitForRequest(
            (request) => request.kind === "typing" && request.channelId === threadId,
            10_000,
          );
          const outbound = await discord.waitForRequest(
            (request) =>
              request.kind === "sendMessage" &&
              request.channelId === threadId &&
              request.body.content === expectedReply,
            10_000,
          );

          expect(discord.requests.indexOf(outbound)).toBeGreaterThan(
            discord.requests.indexOf(typing),
          );

          const sessionEntry = await harness.waitForSessionStoreEntry(
            `agent:main:discord:channel:${threadId}`,
          );
          expect(sessionEntry).toMatchObject({
            lastChannel: "discord",
            lastTo: `channel:${threadId}`,
          });
        },
      );
    },
    60_000,
  );

  test("drops a Discord guild message when bot is not mentioned (requireMention default)", async () => {
    const guildId = "9001";
    const channelId = "777001";
    const userId = "4242";
    const mentionedText = "mentioned hello";
    const unmatchedText = "unmatched hello without mention";
    const expectedReply = "DISCORD_MENTION_GATE_OK";

    await withMuxOpenClawHarness(
      {
        channel: "discord",
        chatId: guildId,
        claimedSessionKey: `agent:main:discord:channel:${channelId}`,
        pairingRouteKey: `discord:default:guild:${guildId}`,
        llmReplyText: expectedReply,
        resolutionMode: "session-first",
        minimalGateway: false,
        discordGatewayGuildEnabled: true,
      },
      async (harness) => {
        const discord = harness.discord;
        expect(discord).toBeDefined();
        if (!discord) {
          throw new Error("discord harness not available");
        }

        discord.registerGuildChannel({ guildId, channelId });

        // Send a guild message WITHOUT mentioning the bot — should be silently dropped.
        discord.enqueueGuildMessage({
          guildId,
          channelId,
          messageId: "9301",
          content: unmatchedText,
          authorId: userId,
          username: "guild-user",
        });

        // Give the mux-server time to forward the un-mentioned message.
        await new Promise((r) => setTimeout(r, 2_000));

        // The un-mentioned message should NOT reach the LLM.
        const llmHit = harness.openai.requests.find((r) => r.lastUserText.includes(unmatchedText));
        expect(llmHit).toBeUndefined();

        // Now send a message WITH the bot mentioned — should go through.
        discord.enqueueGuildMessage({
          guildId,
          channelId,
          messageId: "9302",
          content: `<@${discord.botUserId}> ${mentionedText}`,
          authorId: userId,
          username: "guild-user",
          mentions: [{ id: discord.botUserId, username: "integration-bot", bot: true }],
        });

        await harness.openai.waitForRequest(
          (request) => request.lastUserText.includes(mentionedText),
          10_000,
        );

        const outbound = await discord.waitForRequest(
          (request) =>
            request.kind === "sendMessage" &&
            request.channelId === channelId &&
            request.body.content === expectedReply,
          10_000,
        );
        expect(outbound).toBeDefined();
      },
    );
  }, 60_000);

  test("detects mention from body text when mentions array is empty", async () => {
    const guildId = "9001";
    const channelId = "777001";
    const userId = "4242";
    const inboundText = "body-mention hello";
    const expectedReply = "DISCORD_BODY_MENTION_OK";

    await withMuxOpenClawHarness(
      {
        channel: "discord",
        chatId: guildId,
        claimedSessionKey: `agent:main:discord:channel:${channelId}`,
        pairingRouteKey: `discord:default:guild:${guildId}`,
        llmReplyText: expectedReply,
        resolutionMode: "session-first",
        minimalGateway: false,
        discordGatewayGuildEnabled: true,
      },
      async (harness) => {
        const discord = harness.discord;
        expect(discord).toBeDefined();
        if (!discord) {
          throw new Error("discord harness not available");
        }

        discord.registerGuildChannel({ guildId, channelId });

        // Send a guild message WITH <@BOT_ID> in the body text but WITHOUT
        // the bot in the mentions array.  The mux-server forwards the raw
        // Discord data; the gateway computes wasMentioned using the same
        // matchesMentionWithExplicit logic as the non-mux adapter.
        discord.enqueueGuildMessage({
          guildId,
          channelId,
          messageId: "9401",
          content: `<@${discord.botUserId}> ${inboundText}`,
          authorId: userId,
          username: "guild-user",
          // Deliberately omit mentions array — the gateway must detect the
          // mention via body-text regex from the raw Discord data.
        });

        await harness.openai.waitForRequest(
          (request) => request.lastUserText.includes(inboundText),
          10_000,
        );

        const outbound = await discord.waitForRequest(
          (request) =>
            request.kind === "sendMessage" &&
            request.channelId === channelId &&
            request.body.content === expectedReply,
          10_000,
        );
        expect(outbound).toBeDefined();
      },
    );
  }, 60_000);
});
