import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { callGateway } from "../../src/gateway/call.js";
import {
  loadPendingDeliveries,
  type QueuedDelivery,
} from "../../src/infra/outbound/delivery-queue.js";
import { withMuxOpenClawHarness } from "./mux-openclaw-harness.js";
import { TELEGRAM_MUX_ROUND_TRIP_SCENARIOS } from "./telegram-scenarios.js";
import { sleep, waitForCondition } from "./test-utils.js";

const scenario = TELEGRAM_MUX_ROUND_TRIP_SCENARIOS.find(
  (entry) => entry.id === "dm-text-legacy-binding",
);

if (!scenario) {
  throw new Error("missing dm-text-legacy-binding scenario");
}

async function waitForPendingDeliveries(
  stateDir: string,
  predicate: (entries: QueuedDelivery[]) => QueuedDelivery[] | null,
  timeoutMs: number,
): Promise<QueuedDelivery[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await loadPendingDeliveries(stateDir);
    const matched = predicate(entries);
    if (matched) {
      return matched;
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for queued deliveries");
}

async function rewriteQueuedDelivery(stateDir: string, entry: QueuedDelivery): Promise<void> {
  const queueFile = path.join(stateDir, "delivery-queue", `${entry.id}.json`);
  const rewritten: QueuedDelivery = {
    ...entry,
    retryCount: 0,
    lastError: "forced fake Telegram failure",
  };
  await fs.writeFile(queueFile, `${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
}

describe("mux Telegram restart recovery", () => {
  for (const resolutionMode of ["session-first", "target-first"] as const) {
    test(
      `replays queued gateway send after restart in ${resolutionMode} mode`,
      { timeout: 180_000 },
      async () => {
        const message = `RESTART_OK_${resolutionMode}`;
        await withMuxOpenClawHarness(
          {
            chatId: scenario.chatId,
            claimedSessionKey: scenario.claimSessionKey(scenario.chatId),
            pairingRouteKey: scenario.pairingRouteKey?.(scenario.chatId),
            llmReplyText: "unused",
            resolutionMode,
            minimalGateway: false,
          },
          async (harness) => {
            harness.telegram.failNextMethod("sendMessage", {
              status: 500,
            });

            await expect(
              callGateway({
                url: harness.gatewayUrl,
                token: harness.gatewayToken,
                method: "send",
                params: {
                  to: `telegram:${scenario.chatId}`,
                  channel: "telegram",
                  message,
                  idempotencyKey: randomUUID(),
                },
                timeoutMs: 20_000,
              }),
            ).rejects.toThrow();

            await harness.telegram.waitForMethodCall(
              "sendMessage",
              (request) =>
                String(request.body.chat_id) === scenario.chatId &&
                String(request.body.text).includes(message),
              30_000,
            );

            const [pendingEntry] = await waitForPendingDeliveries(
              harness.stateDir,
              (entries) => (entries.length > 0 ? entries : null),
              30_000,
            );
            if (!pendingEntry) {
              throw new Error("expected a queued Telegram delivery after forced failure");
            }
            expect(pendingEntry.channel).toBe("telegram");
            expect(pendingEntry.to).toBe(`telegram:${scenario.chatId}`);
            expect(pendingEntry.agentId).toBe("main");

            await rewriteQueuedDelivery(harness.stateDir, pendingEntry);
            await harness.restartGateway();

            const replayedRequests = await waitForCondition(
              () => {
                const requests = harness.telegram
                  .getMethodCalls("sendMessage")
                  .filter(
                    (request) =>
                      String(request.body.chat_id) === scenario.chatId &&
                      String(request.body.text).includes(message),
                  );
                return requests.length >= 2 ? requests : undefined;
              },
              45_000,
              `timed out waiting for replayed Telegram sendMessage (${resolutionMode})`,
            );
            expect(replayedRequests).toHaveLength(2);

            const remainingEntries = await waitForPendingDeliveries(
              harness.stateDir,
              (entries) => (entries.length === 0 ? entries : null),
              10_000,
            );
            expect(remainingEntries).toHaveLength(0);
            expect(harness.openai.requests).toHaveLength(0);
          },
        );
      },
    );
  }
});
