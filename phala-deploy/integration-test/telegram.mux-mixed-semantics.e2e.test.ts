import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { callGateway } from "../../src/gateway/call.js";
import { withMuxOpenClawHarness } from "./mux-openclaw-harness.js";
import { TELEGRAM_MUX_ROUND_TRIP_SCENARIOS } from "./telegram-scenarios.js";
import { waitForCondition } from "./test-utils.js";

const scenario = TELEGRAM_MUX_ROUND_TRIP_SCENARIOS.find(
  (entry) => entry.id === "dm-text-legacy-binding",
);

if (!scenario) {
  throw new Error("missing dm-text-legacy-binding scenario");
}

describe("mux Telegram mixed semantics", () => {
  for (const resolutionMode of ["session-first", "target-first"] as const) {
    test(
      `handles legacy inbound traffic and canonical outbound traffic on one mux-server in ${resolutionMode} mode`,
      { timeout: 180_000 },
      async () => {
        const inboundText = `mixed inbound ${resolutionMode}`;
        const legacyReply = `LEGACY_REPLY_${resolutionMode}`;
        const canonicalMessage = `CANONICAL_SEND_${resolutionMode}`;

        await withMuxOpenClawHarness(
          {
            chatId: scenario.chatId,
            claimedSessionKey: scenario.claimSessionKey(scenario.chatId),
            pairingRouteKey: scenario.pairingRouteKey?.(scenario.chatId),
            llmReplyText: legacyReply,
            resolutionMode,
            minimalGateway: false,
            telegramStreamMode: "off",
          },
          async (harness) => {
            harness.telegram.enqueueUpdate(
              scenario.buildInboundUpdate({
                chatId: scenario.chatId,
                inboundText,
              }),
            );

            await harness.openai.waitForRequest(
              (request) => request.lastUserText.includes(inboundText),
              20_000,
            );
            await harness.telegram.waitForMethodCall(
              "sendMessage",
              (request) =>
                String(request.body.chat_id) === scenario.chatId &&
                String(request.body.text).includes(legacyReply),
              30_000,
            );

            const canonicalResponse = await callGateway({
              url: harness.gatewayUrl,
              token: harness.gatewayToken,
              method: "send",
              params: {
                to: `telegram:${scenario.chatId}`,
                channel: "telegram",
                message: canonicalMessage,
                idempotencyKey: randomUUID(),
              },
              timeoutMs: 20_000,
            });
            expect(canonicalResponse).toBeDefined();

            await harness.telegram.waitForMethodCall(
              "sendMessage",
              (request) =>
                String(request.body.chat_id) === scenario.chatId &&
                String(request.body.text).includes(canonicalMessage),
              30_000,
            );

            const matchedSends = await waitForCondition(
              () => {
                const requests = harness.telegram
                  .getMethodCalls("sendMessage")
                  .filter(
                    (request) =>
                      String(request.body.chat_id) === scenario.chatId &&
                      (String(request.body.text).includes(legacyReply) ||
                        String(request.body.text).includes(canonicalMessage)),
                  );
                return requests.length >= 2 ? requests : undefined;
              },
              15_000,
              `timed out waiting for mixed semantics sends (${resolutionMode})`,
            );
            const matchedTexts = new Set(
              matchedSends.map((request) =>
                String(request.body.text).includes(canonicalMessage)
                  ? canonicalMessage
                  : legacyReply,
              ),
            );
            expect(matchedTexts).toEqual(new Set([legacyReply, canonicalMessage]));

            const canonicalSessionKey = scenario.expectedSessionKey?.(scenario.chatId);
            if (!canonicalSessionKey) {
              throw new Error("mixed semantics scenario requires canonical session key");
            }
            const sessionEntry = await harness.waitForSessionStoreEntry(canonicalSessionKey);
            expect(sessionEntry.lastChannel).toBe("telegram");
            expect(sessionEntry.lastTo).toBe(`telegram:${scenario.chatId}`);
            expect(harness.openai.requests).toHaveLength(1);
          },
        );
      },
    );
  }
});
