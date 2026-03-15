import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

const muxDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ADMIN_TOKEN = "test-admin-token";

type RunningServer = {
  process: ChildProcessWithoutNullStreams;
  port: number;
  tempDir: string;
  cleanupTempDir: boolean;
};

type RunningHttpServer = {
  server: http.Server;
};

type RunningWsServer = {
  server: WebSocketServer;
};

const runningServers: RunningServer[] = [];
const runningHttpServers: RunningHttpServer[] = [];
const runningWsServers: RunningWsServer[] = [];

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
  pairingCodesJson?: string;
  extraEnv?: Record<string, string>;
}): Promise<RunningServer> {
  const port = await getFreePort();
  const tempDir = options?.tempDir ?? mkdtempSync(resolve(tmpdir(), "mux-server-test-"));
  const cleanupTempDir = options?.cleanupTempDir ?? !options?.tempDir;
  const dbPath = options?.dbPath ?? resolve(tempDir, "mux-server.sqlite");
  const child = spawn("node", ["--import", "tsx", "src/server.ts"], {
    cwd: muxDir,
    env: {
      ...globalThis.process.env,
      NODE_ENV: "test",
      TELEGRAM_BOT_TOKEN: "dummy-token",
      DISCORD_BOT_TOKEN: "dummy-discord-token",
      MUX_ADMIN_TOKEN: DEFAULT_ADMIN_TOKEN,
      MUX_API_KEY: options?.apiKey ?? "test-key",
      ...(options?.tenantsJson ? { MUX_TENANTS_JSON: options.tenantsJson } : {}),
      ...(options?.pairingCodesJson ? { MUX_PAIRING_CODES_JSON: options.pairingCodesJson } : {}),
      ...options?.extraEnv,
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

async function startHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ url: string; server: RunningHttpServer }> {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveServer();
    });
  });
  const running = { server };
  runningHttpServers.push(running);
  return { url: `http://127.0.0.1:${port}`, server: running };
}

async function stopHttpServer(running: RunningHttpServer): Promise<void> {
  running.server.closeAllConnections();
  await new Promise<void>((resolveServer) => {
    running.server.close(() => resolveServer());
  });
}

async function startWsServer(
  onConnection: (socket: WebSocket) => void | Promise<void>,
): Promise<{ url: string; server: RunningWsServer }> {
  const port = await getFreePort();
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  wsServer.on("connection", (socket) => {
    void onConnection(socket);
  });
  await new Promise<void>((resolveServer, reject) => {
    wsServer.once("listening", () => resolveServer());
    wsServer.once("error", reject);
  });
  const running = { server: wsServer };
  runningWsServers.push(running);
  return { url: `ws://127.0.0.1:${port}`, server: running };
}

async function stopWsServer(running: RunningWsServer): Promise<void> {
  for (const client of running.server.clients) {
    client.terminate();
  }
  await new Promise<void>((resolveServer) => {
    running.server.close(() => resolveServer());
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function toSafeString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function filterRealInbound(
  requests: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return requests.filter((r) => {
    const messageId = toSafeString(r.messageId);
    return !messageId.startsWith("synth:");
  });
}

function readHeaderString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) {
    return value[0].trim();
  }
  return null;
}

function readBearerToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid jwt format");
  }
  const payloadPart = parts[1] ?? "";
  const normalized = payloadPart.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function expectInboundJwtAuth(
  params: { authorization: unknown; openclawIdHeader: unknown },
  expectedOpenclawId: string,
) {
  expect(readHeaderString(params.openclawIdHeader)).toBe(expectedOpenclawId);
  const token = readBearerToken(params.authorization);
  expect(token).toBeTruthy();
  if (!token) {
    return;
  }
  const payload = decodeJwtPayload(token);
  expect(toSafeString(payload.sub)).toBe(expectedOpenclawId);
  const aud = payload.aud;
  const audiences = Array.isArray(aud)
    ? aud.map((entry) => toSafeString(entry)).filter(Boolean)
    : typeof aud === "string"
      ? [aud]
      : [];
  expect(audiences).toContain("openclaw-mux-inbound");
  expect(toSafeString(payload.scope)).toContain("mux:inbound");
}

function expectMuxTraceIdHeader(value: unknown) {
  const traceId = readHeaderString(value);
  expect(traceId).toBeTruthy();
  expect(traceId).toMatch(/^mux_[a-f0-9]{20}$/);
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  errorMessage: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error(errorMessage);
}

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    if (server) {
      await stopServer(server);
    }
  }
  while (runningHttpServers.length > 0) {
    const server = runningHttpServers.pop();
    if (server) {
      await stopHttpServer(server);
    }
  }
  while (runningWsServers.length > 0) {
    const server = runningWsServers.pop();
    if (server) {
      await stopWsServer(server);
    }
  }
});

function requestPayload(text: string) {
  return {
    channel: "telegram",
    sessionKey: "agent:main:telegram:group:-100123:topic:2",
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

async function claimPairing(params: {
  port: number;
  apiKey: string;
  code: string;
  sessionKey?: string;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/pairings/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: params.code,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    }),
  });
}

function readSessionRouteKeys(params: {
  dbPath: string;
  channel: string;
  tenantId?: string;
}): string[] {
  const db = new DatabaseSync(params.dbPath, { open: true, readOnly: true });
  try {
    const statement = params.tenantId
      ? db.prepare(
          `SELECT session_key
           FROM session_routes
           WHERE tenant_id = ? AND channel = ?
           ORDER BY session_key`,
        )
      : db.prepare(
          `SELECT session_key
           FROM session_routes
           WHERE channel = ?
           ORDER BY session_key`,
        );
    const rows = (
      params.tenantId
        ? statement.all(params.tenantId, params.channel)
        : statement.all(params.channel)
    ) as Array<{ session_key?: unknown }>;
    return rows.map((row) => toSafeString(row.session_key)).filter(Boolean);
  } finally {
    db.close();
  }
}

function readMuxServerLog(logPath: string): string {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

async function listPairings(params: { port: number; apiKey: string }) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/pairings`, {
    headers: { Authorization: `Bearer ${params.apiKey}` },
  });
}

async function unbindPairing(params: { port: number; apiKey: string; bindingId: string }) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/pairings/unbind`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bindingId: params.bindingId }),
  });
}

async function getAdminWhatsAppHealth(params: { port: number; adminToken: string }) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/admin/whatsapp/health`, {
    headers: {
      Authorization: `Bearer ${params.adminToken}`,
    },
  });
}

async function createAdminPairingToken(params: {
  port: number;
  adminToken: string;
  openclawId: string;
  inboundUrl?: string;
  inboundTimeoutMs?: number;
  channel?: string;
  sessionKey?: string;
  ttlSec?: number;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/admin/pairings/token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      openclawId: params.openclawId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.ttlSec ? { ttlSec: params.ttlSec } : {}),
      ...(params.inboundUrl ? { inboundUrl: params.inboundUrl } : {}),
      ...(params.inboundTimeoutMs ? { inboundTimeoutMs: params.inboundTimeoutMs } : {}),
    }),
  });
}

async function registerInstance(params: {
  port: number;
  registerKey: string;
  openclawId: string;
  inboundUrl: string;
  inboundTimeoutMs?: number;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/instances/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.registerKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      openclawId: params.openclawId,
      inboundUrl: params.inboundUrl,
      ...(params.inboundTimeoutMs ? { inboundTimeoutMs: params.inboundTimeoutMs } : {}),
    }),
  });
}

export {
  DEFAULT_ADMIN_TOKEN,
  claimPairing,
  createAdminPairingToken,
  decodeJwtPayload,
  expectInboundJwtAuth,
  expectMuxTraceIdHeader,
  filterRealInbound,
  getAdminWhatsAppHealth,
  getFreePort,
  listPairings,
  mkdtempSync,
  readBearerToken,
  readHeaderString,
  readJsonBody,
  readMuxServerLog,
  readSessionRouteKeys,
  registerInstance,
  removeRunningServer,
  requestPayload,
  resolve,
  rmSync,
  sendWithIdempotency,
  startHttpServer,
  startServer,
  startWsServer,
  stopServer,
  toSafeString,
  tmpdir,
  unbindPairing,
  waitForCondition,
  waitForHealth,
  writeFileSync,
};
export type { RunningHttpServer, RunningServer, RunningWsServer };
export type TestWebSocket = WebSocket;
