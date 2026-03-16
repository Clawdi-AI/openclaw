import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { TELEGRAM_MUX_ROUND_TRIP_SCENARIOS } from "./telegram-scenarios.js";
import { startNodeTsxProcess, stopChildProcess } from "./test-utils.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function waitForScenarioRunnerExit(params: {
  scenarioId: string;
  resolutionMode: "session-first" | "target-first";
}): Promise<void> {
  const runner = startNodeTsxProcess({
    cwd: repoRoot,
    entrypoint: "phala-deploy/integration-test/telegram-scenario-runner.ts",
    args: [params.scenarioId, params.resolutionMode],
    env: {
      NODE_ENV: "test",
    },
  });

  try {
    const exitCode = await Promise.race([
      new Promise<number>((resolveExit) => {
        runner.process.once("exit", (code) => resolveExit(code ?? 0));
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `scenario runner timed out (${params.scenarioId}, ${params.resolutionMode})\n${runner.logs.join("").slice(-12_000)}`,
            ),
          );
        }, 170_000);
      }),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `scenario runner failed (${params.scenarioId}, ${params.resolutionMode}, exit=${exitCode})\n${runner.logs.join("").slice(-12_000)}`,
      );
    }
  } finally {
    await stopChildProcess(runner.process);
  }
}

export function defineTelegramMuxRoundTripTest(
  resolutionMode: "session-first" | "target-first",
): void {
  test(
    `all Telegram mux scenarios in ${resolutionMode} mode`,
    {
      timeout: TELEGRAM_MUX_ROUND_TRIP_SCENARIOS.length * 180_000 + 60_000,
    },
    async () => {
      for (const scenario of TELEGRAM_MUX_ROUND_TRIP_SCENARIOS) {
        console.log(`[integration] start ${scenario.id} (${resolutionMode})`);
        const startedAt = Date.now();
        await waitForScenarioRunnerExit({
          scenarioId: scenario.id,
          resolutionMode,
        });
        console.log(
          `[integration] done ${scenario.id} (${resolutionMode}) in ${Date.now() - startedAt}ms`,
        );
      }
    },
  );
}
