import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { callGateway } from "../../src/gateway/call.js";
import {
  loadPendingDeliveries,
  type QueuedDelivery,
} from "../../src/infra/outbound/delivery-queue.js";
import { withMuxOpenClawHarness } from "./mux-openclaw-harness.js";
import { TELEGRAM_MUX_ROUND_TRIP_SCENARIOS } from "./telegram-scenarios.js";
import { sleep } from "./test-utils.js";

function requireScenario(id: string) {
  const scenario = TELEGRAM_MUX_ROUND_TRIP_SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`missing ${id} scenario`);
  }
  return scenario;
}

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

async function waitForPendingDeliveries(
  stateDir: string,
  predicate: (entries: QueuedDelivery[]) => QueuedDelivery[] | null,
  timeoutMs: number,
): Promise<QueuedDelivery[]> {
  const deadline = Date.now() + timeoutMs;
  let lastEntries: QueuedDelivery[] = [];
  while (Date.now() < deadline) {
    const entries = await loadPendingDeliveries(stateDir);
    lastEntries = entries;
    const matched = predicate(entries);
    if (matched) {
      return matched;
    }
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for queued deliveries\n${JSON.stringify(lastEntries, null, 2)}`,
  );
}

async function rewriteQueuedDelivery(stateDir: string, entry: QueuedDelivery): Promise<void> {
  const queueFile = path.join(stateDir, "delivery-queue", `${entry.id}.json`);
  const rewritten: QueuedDelivery = {
    ...entry,
    retryCount: 0,
    lastError: "forced fake Telegram failure",
  };
  await fsPromises.writeFile(queueFile, `${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
}

async function runLegacyScenario(params: {
  scenarioId: string;
  resolutionMode?: "session-first" | "target-first";
  llmReplyText?: string;
  assertSessionEntry?: boolean;
}) {
  const scenario = requireScenario(params.scenarioId);
  const inboundText = `legacy ${scenario.id}`;
  const expectedReply = params.llmReplyText ?? `LEGACY_${scenario.id}`;

  await withMuxOpenClawHarness(
    {
      chatId: scenario.chatId,
      claimedSessionKey: scenario.claimSessionKey(scenario.chatId),
      pairingRouteKey: scenario.pairingRouteKey?.(scenario.chatId),
      llmReplyText: expectedReply,
      resolutionMode: params.resolutionMode ?? "session-first",
      gatewayRuntime: "legacy",
      legacyRepoPath: legacyRepoPath ?? undefined,
      workspaceFiles: scenario.workspaceFiles,
      telegramStreamMode: scenario.id.includes("streaming") ? "partial" : undefined,
    },
    async (harness) => {
      try {
        if (scenario.beforeDispatch) {
          await scenario.beforeDispatch({
            chatId: scenario.chatId,
            inboundText,
            expectedReply,
            harness,
          });
        }
        harness.telegram.enqueueUpdate(
          scenario.buildInboundUpdate({
            chatId: scenario.chatId,
            inboundText,
          }),
        );
        await scenario.assertOutbound({
          chatId: scenario.chatId,
          inboundText,
          expectedReply,
          harness,
        });
        if (scenario.assertOpenAi) {
          await scenario.assertOpenAi({
            chatId: scenario.chatId,
            inboundText,
            expectedReply,
            harness,
          });
        }
        const sessionKey = scenario.expectedSessionKey?.(scenario.chatId);
        if (params.assertSessionEntry !== false && sessionKey && scenario.assertSessionEntry) {
          const sessionEntry = await harness.waitForSessionStoreEntry(sessionKey);
          scenario.assertSessionEntry({
            chatId: scenario.chatId,
            inboundText,
            expectedReply,
            harness,
            sessionEntry,
          });
        }
      } catch (error) {
        const logs = harness.readRecentLogs();
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n\nGateway logs:\n${logs.gateway}\n\nMux logs:\n${logs.muxServer}`,
          { cause: error },
        );
      }
    },
  );
}

describe("mux Telegram real legacy OpenClaw compatibility", () => {
  const legacyTest = shouldRunLegacyCompat ? test : test.skip;

  legacyTest("round-trips a real legacy DM message", { timeout: 180_000 }, async () => {
    expect(legacyRepoPath).toBeTruthy();
    await runLegacyScenario({
      scenarioId: "dm-text-legacy-binding",
      llmReplyText: "LEGACY_GATEWAY_REPLY",
      assertSessionEntry: false,
    });
  });

  legacyTest("renders and handles legacy callback/edit flow", { timeout: 180_000 }, async () => {
    await runLegacyScenario({
      scenarioId: "dm-models-callback-edit",
      llmReplyText: "",
    });
  });

  legacyTest("round-trips a real legacy group message", { timeout: 180_000 }, async () => {
    await runLegacyScenario({
      scenarioId: "group-text-legacy-binding",
      assertSessionEntry: false,
    });
  });

  legacyTest("round-trips a real legacy forum topic message", { timeout: 180_000 }, async () => {
    await runLegacyScenario({
      scenarioId: "forum-topic-text-legacy-binding",
      assertSessionEntry: false,
    });
  });

  legacyTest("replays queued legacy gateway send after restart", { timeout: 180_000 }, async () => {
    const scenario = requireScenario("dm-text-legacy-binding");
    const message = "LEGACY_RESTART_GATEWAY_SEND";

    await withMuxOpenClawHarness(
      {
        chatId: scenario.chatId,
        claimedSessionKey: scenario.claimSessionKey(scenario.chatId),
        pairingRouteKey: scenario.pairingRouteKey?.(scenario.chatId),
        llmReplyText: "unused",
        resolutionMode: "session-first",
        minimalGateway: false,
        gatewayRuntime: "legacy",
        legacyRepoPath: legacyRepoPath ?? undefined,
      },
      async (harness) => {
        try {
          harness.telegram.setMethodFailure("sendMessage", { status: 500 });

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
          expect(pendingEntry.channel).toBe("telegram");
          harness.telegram.setMethodFailure("sendMessage", null);
          await rewriteQueuedDelivery(harness.stateDir, pendingEntry);
          await harness.restartGateway();

          const replayed = await harness.telegram.waitForMethodCall(
            "sendMessage",
            (request) =>
              String(request.body.chat_id) === scenario.chatId &&
              String(request.body.text).includes(message),
            45_000,
          );
          expect(String(replayed.body.text)).toContain(message);
        } catch (error) {
          const logs = harness.readRecentLogs();
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n\nGateway logs:\n${logs.gateway}\n\nMux logs:\n${logs.muxServer}`,
            { cause: error },
          );
        }
      },
    );
  });
});
