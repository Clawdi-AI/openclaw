import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  addMuxPairedSender,
  readMuxPairedSenders,
  resolveMuxPairingAnchorRouteKey,
} from "./mux-paired-senders.js";

let fixtureRoot = "";
let caseId = 0;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mux-paired-"));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function withTempStateDir<T>(fn: () => Promise<T>) {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  await fs.mkdir(dir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = dir;
  try {
    return await fn();
  } finally {
    envSnapshot.restore();
  }
}

describe("mux paired senders store", () => {
  it("anchors telegram topic routes to the whole chat", async () => {
    await withTempStateDir(async () => {
      await addMuxPairedSender({
        channel: "telegram",
        accountId: "default",
        routeKey: "telegram:default:chat:-100123:topic:14",
        senderId: "111",
      });

      expect(
        await readMuxPairedSenders({
          channel: "telegram",
          accountId: "default",
          routeKey: "telegram:default:chat:-100123:topic:99",
        }),
      ).toEqual(["111"]);
    });
  });

  it("anchors discord thread routes to the whole guild", async () => {
    await withTempStateDir(async () => {
      await addMuxPairedSender({
        channel: "discord",
        accountId: "default",
        routeKey: "discord:default:guild:9001:channel:12345:thread:777101",
        senderId: "4242",
      });

      expect(
        await readMuxPairedSenders({
          channel: "discord",
          accountId: "default",
          routeKey: "discord:default:guild:9001:channel:98765:thread:777102",
        }),
      ).toEqual(["4242"]);
    });
  });

  it("preserves direct-message anchors", () => {
    expect(resolveMuxPairingAnchorRouteKey("discord:default:dm:user:42")).toBe(
      "discord:default:dm:user:42",
    );
  });
});
