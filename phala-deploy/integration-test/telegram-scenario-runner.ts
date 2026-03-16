import { withMuxOpenClawHarness } from "./mux-openclaw-harness.js";
import { TELEGRAM_MUX_ROUND_TRIP_SCENARIOS } from "./telegram-scenarios.js";

async function main(): Promise<void> {
  const scenarioId = process.argv[2]?.trim();
  const resolutionMode = process.argv[3]?.trim();
  if (!scenarioId) {
    throw new Error("missing scenario id");
  }
  if (resolutionMode !== "session-first" && resolutionMode !== "target-first") {
    throw new Error(`invalid resolution mode: ${resolutionMode ?? "<missing>"}`);
  }

  const scenario = TELEGRAM_MUX_ROUND_TRIP_SCENARIOS.find((entry) => entry.id === scenarioId);
  if (!scenario) {
    throw new Error(`unknown scenario: ${scenarioId}`);
  }

  const expectedReply = `INTEGRATION_OK_${scenario.id}_${resolutionMode}`;
  const inboundText = `hello from ${scenario.id} ${resolutionMode}`;

  await withMuxOpenClawHarness(
    {
      chatId: scenario.chatId,
      claimedSessionKey: scenario.claimSessionKey(scenario.chatId),
      pairingRouteKey: scenario.pairingRouteKey?.(scenario.chatId),
      llmReplyText: expectedReply,
      resolutionMode,
      openAiResponder: scenario.openAiResponder({
        chatId: scenario.chatId,
        inboundText,
        expectedReply,
      }),
      workspaceFiles: scenario.workspaceFiles,
    },
    async (harness) => {
      await scenario.beforeDispatch?.({
        harness,
        chatId: scenario.chatId,
        inboundText,
        expectedReply,
      });
      harness.telegram.enqueueUpdate(
        scenario.buildInboundUpdate({
          chatId: scenario.chatId,
          inboundText,
        }),
      );

      await scenario.assertOutbound({
        harness,
        chatId: scenario.chatId,
        inboundText,
        expectedReply,
      });
      await scenario.assertOpenAi?.({
        harness,
        chatId: scenario.chatId,
        inboundText,
        expectedReply,
      });
      if (scenario.expectedSessionKey && scenario.assertSessionEntry) {
        const canonicalSessionKey = scenario.expectedSessionKey(scenario.chatId);
        const sessionEntry = await harness.waitForSessionStoreEntry(canonicalSessionKey);
        scenario.assertSessionEntry({
          harness,
          chatId: scenario.chatId,
          inboundText,
          expectedReply,
          sessionEntry,
        });
      }
    },
  );

  process.stdout.write(`${JSON.stringify({ ok: true, scenarioId, resolutionMode }, null, 2)}\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
