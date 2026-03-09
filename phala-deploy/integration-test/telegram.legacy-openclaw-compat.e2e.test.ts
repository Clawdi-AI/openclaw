import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { withMuxOpenClawHarness } from "./mux-openclaw-harness.js";
import { TELEGRAM_MUX_ROUND_TRIP_SCENARIOS } from "./telegram-scenarios.js";

const scenario = TELEGRAM_MUX_ROUND_TRIP_SCENARIOS.find(
  (entry) => entry.id === "dm-text-legacy-binding",
);

if (!scenario) {
  throw new Error("missing dm-text-legacy-binding scenario");
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

describe("mux Telegram real legacy OpenClaw compatibility", () => {
  const legacyTest = shouldRunLegacyCompat ? test : test.skip;

  legacyTest(
    "runs a real phala-2026.2.17 gateway against the current mux-server",
    { timeout: 180_000 },
    async () => {
      if (!legacyRepoPath) {
        throw new Error("missing legacy OpenClaw repo path");
      }
      const inboundText = "legacy gateway inbound";
      const legacyReply = "LEGACY_GATEWAY_REPLY";

      await withMuxOpenClawHarness(
        {
          chatId: scenario.chatId,
          claimedSessionKey: scenario.claimSessionKey(scenario.chatId),
          pairingRouteKey: scenario.pairingRouteKey?.(scenario.chatId),
          llmReplyText: legacyReply,
          resolutionMode: "session-first",
          gatewayRuntime: "legacy",
          legacyRepoPath,
        },
        async (harness) => {
          try {
            harness.telegram.enqueueUpdate(
              scenario.buildInboundUpdate({
                chatId: scenario.chatId,
                inboundText,
              }),
            );

            await harness.openai.waitForRequest(
              (request) => request.lastUserText.includes(inboundText),
              30_000,
            );
            const send = await harness.telegram.waitForMethodCall(
              "sendMessage",
              (request) =>
                String(request.body.chat_id) === scenario.chatId &&
                String(request.body.text).includes(legacyReply),
              30_000,
            );
            expect(String(send.body.chat_id)).toBe(scenario.chatId);
            expect(String(send.body.text)).toContain(legacyReply);
          } catch (error) {
            const logs = harness.readRecentLogs();
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}\n\nGateway logs:\n${logs.gateway}\n\nMux logs:\n${logs.muxServer}`,
              { cause: error },
            );
          }
        },
      );
    },
  );
});
