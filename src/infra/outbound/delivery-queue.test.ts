import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
}));

vi.mock("../../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../../logger.js")>("../../logger.js");
  return {
    ...actual,
    logWarn: loggerMocks.logWarn,
  };
});

const { ensureQueueDir, enqueueDelivery, loadPendingDeliveries } =
  await import("./delivery-queue.js");

describe("delivery queue", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-delivery-queue-"));
    loggerMocks.logWarn.mockReset();
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("moves malformed queue entries to failed and warns once", async () => {
    await enqueueDelivery(
      {
        channel: "telegram",
        to: "123",
        agentId: "main",
        payloads: [{ text: "hi" }],
      },
      stateDir,
    );
    const queueDir = await ensureQueueDir(stateDir);
    const malformedPath = path.join(queueDir, "broken.json");
    await fs.promises.writeFile(malformedPath, "{not-json", "utf-8");

    const pending = await loadPendingDeliveries(stateDir);

    expect(pending).toHaveLength(1);
    expect(await fs.promises.stat(path.join(queueDir, "broken.json")).catch(() => null)).toBeNull();
    expect(
      await fs.promises
        .stat(path.join(queueDir, "failed", "broken.invalid.json"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(loggerMocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("moved malformed queue entry broken.json to failed/"),
    );
  });
});
