import { describe, expect, test } from "vitest";
import { withMuxOpenClawHarness } from "./mux-openclaw-harness.js";

describe("WhatsApp mux round trip", () => {
  test.each(["session-first", "target-first"] as const)(
    "round-trips a WhatsApp DM in %s mode",
    async (resolutionMode) => {
      const chatJid = "15550001111@s.whatsapp.net";
      const senderE164 = "+15550001111";
      const inboundText = `hello from whatsapp ${resolutionMode}`;
      const expectedReply = `WHATSAPP_OK_${resolutionMode}`;

      await withMuxOpenClawHarness(
        {
          channel: "whatsapp",
          chatId: chatJid,
          claimedSessionKey: `wa:dm:${senderE164}`,
          llmReplyText: expectedReply,
          resolutionMode,
          minimalGateway: false,
        },
        async (harness) => {
          const whatsapp = harness.whatsapp;
          expect(whatsapp).toBeDefined();
          if (!whatsapp) {
            throw new Error("whatsapp harness not available");
          }

          whatsapp.enqueueMessage({
            id: "wa-in-9001",
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

          const typing = await whatsapp
            .waitForRequest((request) => request.kind === "typing" && request.to === chatJid)
            .catch((error) => {
              const logs = harness.readRecentLogs();
              throw new Error(
                `${String(error)}\n--- gateway ---\n${logs.gateway}\n--- mux ---\n${logs.muxServer}`,
              );
            });

          const outbound = await whatsapp
            .waitForRequest(
              (request) =>
                request.kind === "sendMessage" &&
                request.to === chatJid &&
                request.text === expectedReply,
            )
            .catch((error) => {
              const logs = harness.readRecentLogs();
              throw new Error(
                `${String(error)}\n--- gateway ---\n${logs.gateway}\n--- mux ---\n${logs.muxServer}`,
              );
            });

          expect(whatsapp.requests.indexOf(outbound)).toBeGreaterThan(
            whatsapp.requests.indexOf(typing),
          );

          const sessionEntry = await harness.waitForSessionStoreEntry("agent:main:main");
          expect(sessionEntry).toMatchObject({
            lastChannel: "whatsapp",
          });
        },
      );
    },
    60_000,
  );
});
