import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { withMuxOpenClawHarness } from "./mux-openclaw-harness.js";

function resolveLegacyRepoPath(): string | null {
  const explicit = process.env.OPENCLAW_LEGACY_REPO?.trim();
  if (explicit) {
    return fs.existsSync(explicit) ? explicit : null;
  }
  const defaultPath = path.join(os.homedir(), "tmp", "openclaw");
  return fs.existsSync(defaultPath) ? defaultPath : null;
}

const legacyRepoPath = resolveLegacyRepoPath();
const shouldRunLegacyCompat =
  process.env.OPENCLAW_RUN_LEGACY_COMPAT === "1" && Boolean(legacyRepoPath);

describe("mux non-Telegram real legacy OpenClaw compatibility", () => {
  const legacyTest = shouldRunLegacyCompat ? test : test.skip;

  legacyTest("round-trips a real legacy Discord DM message", { timeout: 180_000 }, async () => {
    const userId = "4242";
    const channelId = "3001";
    const inboundText = "legacy discord dm";
    const expectedReply = "LEGACY_DISCORD_DM_OK";

    await withMuxOpenClawHarness(
      {
        channel: "discord",
        chatId: userId,
        claimedSessionKey: `dc:dm:${userId}`,
        llmReplyText: expectedReply,
        resolutionMode: "session-first",
        minimalGateway: false,
        gatewayRuntime: "legacy",
        legacyRepoPath: legacyRepoPath ?? undefined,
      },
      async (harness) => {
        const discord = harness.discord;
        expect(discord).toBeDefined();
        if (!discord) {
          throw new Error("discord harness not available");
        }

        discord.registerDmChannel(userId, channelId);
        discord.enqueueDmMessage({
          userId,
          channelId,
          messageId: "990001",
          content: inboundText,
          timestamp: "2026-01-01T00:00:00.000Z",
          username: "discord-user",
        });

        await harness.openai.waitForRequest(
          (request) => request.lastUserText.includes(inboundText),
          10_000,
        );
        await discord.waitForRequest(
          (request) =>
            request.kind === "sendMessage" &&
            request.channelId === channelId &&
            request.body.content === expectedReply,
          10_000,
        );
      },
    );
  });

  legacyTest(
    "round-trips a real legacy Discord guild channel message",
    { timeout: 180_000 },
    async () => {
      const guildId = "9001";
      const channelId = "777001";
      const userId = "4242";
      const inboundText = "legacy discord guild";
      const expectedReply = "LEGACY_DISCORD_GUILD_OK";

      await withMuxOpenClawHarness(
        {
          channel: "discord",
          chatId: guildId,
          claimedSessionKey: `dc:guild:${guildId}`,
          pairingRouteKey: `discord:default:guild:${guildId}`,
          llmReplyText: expectedReply,
          resolutionMode: "session-first",
          minimalGateway: false,
          discordGatewayGuildEnabled: true,
          gatewayRuntime: "legacy",
          legacyRepoPath: legacyRepoPath ?? undefined,
        },
        async (harness) => {
          const discord = harness.discord;
          expect(discord).toBeDefined();
          if (!discord) {
            throw new Error("discord harness not available");
          }

          discord.registerGuildChannel({ guildId, channelId });
          discord.enqueueGuildMessage({
            guildId,
            channelId,
            messageId: "990101",
            content: inboundText,
            authorId: userId,
            username: "guild-user",
          });

          await harness.openai.waitForRequest(
            (request) => request.lastUserText.includes(inboundText),
            10_000,
          );
          await discord.waitForRequest(
            (request) =>
              request.kind === "sendMessage" &&
              request.channelId === channelId &&
              request.body.content === expectedReply,
            10_000,
          );
        },
      );
    },
  );

  legacyTest("round-trips a real legacy WhatsApp DM message", { timeout: 180_000 }, async () => {
    const chatJid = "15550001111@s.whatsapp.net";
    const senderE164 = "+15550001111";
    const inboundText = "legacy whatsapp dm";
    const expectedReply = "LEGACY_WHATSAPP_DM_OK";

    await withMuxOpenClawHarness(
      {
        channel: "whatsapp",
        chatId: chatJid,
        claimedSessionKey: `wa:dm:${senderE164}`,
        llmReplyText: expectedReply,
        resolutionMode: "session-first",
        minimalGateway: false,
        gatewayRuntime: "legacy",
        legacyRepoPath: legacyRepoPath ?? undefined,
      },
      async (harness) => {
        const whatsapp = harness.whatsapp;
        expect(whatsapp).toBeDefined();
        if (!whatsapp) {
          throw new Error("whatsapp harness not available");
        }

        whatsapp.enqueueMessage({
          id: "legacy-wa-dm-9001",
          from: senderE164,
          conversationId: senderE164,
          to: "+15551230000",
          accountId: "default",
          body: inboundText,
          chatType: "direct",
          chatId: chatJid,
          senderE164,
          timestamp: Date.now(),
        });

        await harness.openai.waitForRequest(
          (request) => request.lastUserText.includes(inboundText),
          10_000,
        );
        await whatsapp.waitForRequest(
          (request) =>
            request.kind === "sendMessage" &&
            request.to === chatJid &&
            request.text === expectedReply,
          10_000,
        );
      },
    );
  });

  legacyTest("round-trips a real legacy WhatsApp group message", { timeout: 180_000 }, async () => {
    const groupJid = "120363401234567890@g.us";
    const senderE164 = "+15550002222";
    const inboundText = "legacy whatsapp group";
    const expectedReply = "LEGACY_WHATSAPP_GROUP_OK";

    await withMuxOpenClawHarness(
      {
        channel: "whatsapp",
        chatId: groupJid,
        claimedSessionKey: `wa:group:${groupJid}`,
        pairingRouteKey: `whatsapp:default:chat:${groupJid}`,
        llmReplyText: expectedReply,
        resolutionMode: "session-first",
        minimalGateway: false,
        gatewayRuntime: "legacy",
        legacyRepoPath: legacyRepoPath ?? undefined,
      },
      async (harness) => {
        const whatsapp = harness.whatsapp;
        expect(whatsapp).toBeDefined();
        if (!whatsapp) {
          throw new Error("whatsapp harness not available");
        }

        whatsapp.enqueueMessage({
          id: "legacy-wa-group-9001",
          from: groupJid,
          conversationId: groupJid,
          to: "+15551230000",
          accountId: "default",
          body: inboundText,
          chatType: "group",
          chatId: groupJid,
          senderE164,
          senderName: "Group Sender",
          pushName: "Group Sender",
          wasMentioned: true,
          timestamp: Date.now(),
        });

        await harness.openai.waitForRequest(
          (request) => request.lastUserText.includes(inboundText),
          10_000,
        );
        await whatsapp.waitForRequest(
          (request) =>
            request.kind === "sendMessage" &&
            request.to === groupJid &&
            request.text === expectedReply,
          10_000,
        );
      },
    );
  });
});
