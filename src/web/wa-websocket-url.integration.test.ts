import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

// Stub the network fetch so tests don't hit raw.githubusercontent.com for the
// Baileys-version lookup. Baileys handles fetch failures gracefully but adds
// unpredictable latency in sandboxed environments.
vi.mock("@whiskeysockets/baileys", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchLatestBaileysVersion: vi.fn(async () => ({
      version: [2, 3000, 1027934701],
      isLatest: false,
    })),
  };
});

import { createWaSocket } from "./session.js";

describe("createWaSocket WA_WEBSOCKET_URL threading", () => {
  let server: WebSocketServer;
  let port: number;
  let authDir: string;
  const connections: Array<{ url?: string }> = [];

  beforeEach(async () => {
    connections.length = 0;
    authDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-wa-ws-url-test-"));
    await new Promise<void>((resolve) => {
      server = new WebSocketServer({ port: 0 }, () => resolve());
    });
    port = (server.address() as { port: number }).port;
    server.on("connection", (ws: WebSocket, req) => {
      connections.push({ url: req.url ?? "/" });
      // Close immediately — we only care about the connection attempt, not
      // the Noise handshake.
      ws.close();
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    vi.unstubAllEnvs();
    await rm(authDir, { recursive: true, force: true });
  });

  it("routes Baileys to the URL in WA_WEBSOCKET_URL when the env is set", async () => {
    vi.stubEnv("WA_WEBSOCKET_URL", `ws://127.0.0.1:${port}`);
    const sock = await createWaSocket(false, false, { authDir });
    try {
      await vi.waitFor(
        () => {
          expect(connections.length).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 100 },
      );
    } finally {
      sock.end(undefined);
    }
  });
});
