import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const muxDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type RunningServer = {
  process: ChildProcessWithoutNullStreams;
  port: number;
  tempDir: string;
  cleanupTempDir: boolean;
};

const runningServers: RunningServer[] = [];

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve test port"));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolvePort(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForHealth(port: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  throw new Error(`mux server did not become healthy on port ${port}`);
}

async function startServer(options?: {
  tempDir?: string;
  cleanupTempDir?: boolean;
  dbPath?: string;
  apiKey?: string;
  tenantsJson?: string;
}): Promise<RunningServer> {
  const port = await getFreePort();
  const tempDir = options?.tempDir ?? mkdtempSync(resolve(tmpdir(), "mux-server-test-"));
  const cleanupTempDir = options?.cleanupTempDir ?? !options?.tempDir;
  const dbPath = options?.dbPath ?? resolve(tempDir, "mux-server.sqlite");
  const child = spawn("node", ["--import", "tsx", "src/server.ts"], {
    cwd: muxDir,
    env: {
      ...globalThis.process.env,
      TELEGRAM_BOT_TOKEN: "dummy-token",
      MUX_API_KEY: options?.apiKey ?? "test-key",
      ...(options?.tenantsJson ? { MUX_TENANTS_JSON: options.tenantsJson } : {}),
      MUX_PORT: String(port),
      MUX_LOG_PATH: resolve(tempDir, "mux-server.log"),
      MUX_DB_PATH: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const running = { process: child, port, tempDir, cleanupTempDir };
  runningServers.push(running);
  await waitForHealth(port);
  return running;
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.process.exitCode === null && !server.process.killed) {
    server.process.kill("SIGINT");
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        if (server.process.exitCode === null && !server.process.killed) {
          server.process.kill("SIGKILL");
        }
        resolveExit();
      }, 3_000);
      server.process.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }

  if (server.cleanupTempDir) {
    rmSync(server.tempDir, { recursive: true, force: true });
  }
}

function removeRunningServer(server: RunningServer) {
  const index = runningServers.indexOf(server);
  if (index >= 0) {
    runningServers.splice(index, 1);
  }
}

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    if (server) {
      await stopServer(server);
    }
  }
});

function requestPayload(text: string) {
  return {
    channel: "telegram",
    sessionKey: "tg:group:-100123:thread:2",
    text,
  };
}

async function sendWithIdempotency(params: {
  port: number;
  apiKey: string;
  idempotencyKey: string;
  text: string;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/mux/outbound/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": params.idempotencyKey,
    },
    body: JSON.stringify(requestPayload(params.text)),
  });
}

describe("mux server", () => {
  test("health endpoint responds", async () => {
    const server = await startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("outbound endpoint rejects unauthorized requests", async () => {
    const server = await startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload("hello")),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("supports per-tenant auth from MUX_TENANTS_JSON", async () => {
    const server = await startServer({
      apiKey: "legacy-key",
      tenantsJson: JSON.stringify([
        { id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" },
        { id: "tenant-b", name: "Tenant B", apiKey: "tenant-b-key" },
      ]),
    });

    const valid = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload("missing to should return 400")),
    });
    expect(valid.status).toBe(400);
    expect(await valid.json()).toEqual({ ok: false, error: "to required" });

    const legacy = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer legacy-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload("missing to should return 400")),
    });
    expect(legacy.status).toBe(401);
    expect(await legacy.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("idempotency replays same payload and rejects mismatched payload", async () => {
    const server = await startServer();
    const first = await sendWithIdempotency({
      port: server.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-1",
      text: "missing to should return 400",
    });
    expect(first.status).toBe(400);
    expect(await first.json()).toEqual({ ok: false, error: "to required" });

    const replay = await sendWithIdempotency({
      port: server.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-1",
      text: "missing to should return 400",
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ ok: false, error: "to required" });

    const mismatch = await sendWithIdempotency({
      port: server.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-1",
      text: "different payload",
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      ok: false,
      error: "idempotency key reused with different payload",
    });
  });

  test("idempotency survives restart with SQLite", async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "mux-server-restart-"));
    const dbPath = resolve(tempDir, "mux-server.sqlite");

    const firstServer = await startServer({
      tempDir,
      cleanupTempDir: false,
      dbPath,
    });
    const first = await sendWithIdempotency({
      port: firstServer.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-restart",
      text: "missing to should return 400",
    });
    expect(first.status).toBe(400);
    expect(await first.json()).toEqual({ ok: false, error: "to required" });

    await stopServer(firstServer);
    removeRunningServer(firstServer);

    const secondServer = await startServer({
      tempDir,
      cleanupTempDir: false,
      dbPath,
    });
    const replay = await sendWithIdempotency({
      port: secondServer.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-restart",
      text: "missing to should return 400",
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ ok: false, error: "to required" });

    const mismatch = await sendWithIdempotency({
      port: secondServer.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-restart",
      text: "different payload after restart",
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      ok: false,
      error: "idempotency key reused with different payload",
    });

    await stopServer(secondServer);
    removeRunningServer(secondServer);
    rmSync(tempDir, { recursive: true, force: true });
  });
});
