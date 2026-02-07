import { createHash } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type MuxPayload = {
  to?: unknown;
  text?: unknown;
  mediaUrl?: unknown;
  replyToId?: unknown;
  threadId?: unknown;
};

type SendResult = {
  statusCode: number;
  bodyText: string;
};

type InflightEntry = {
  fingerprint: string;
  promise: Promise<SendResult>;
};

type TenantSeed = {
  id: string;
  name: string;
  apiKey: string;
};

type TenantIdentity = {
  id: string;
  name: string;
};

type CachedIdempotencyRow = {
  request_fingerprint: string;
  response_status: number;
  response_body: string;
};

const host = process.env.MUX_HOST || "127.0.0.1";
const port = Number(process.env.MUX_PORT || 18891);
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const logPath =
  process.env.MUX_LOG_PATH || path.resolve(process.cwd(), "mux-server", "logs", "mux-server.log");
const dbPath =
  process.env.MUX_DB_PATH || path.resolve(process.cwd(), "mux-server", "data", "mux-server.sqlite");
const idempotencyTtlMs = Number(process.env.MUX_IDEMPOTENCY_TTL_MS || 10 * 60 * 1000);

if (!telegramBotToken?.trim()) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

let tenantSeeds: TenantSeed[] = [];
try {
  tenantSeeds = resolveTenantSeeds();
} catch (error) {
  console.error(`failed to resolve mux tenants: ${String(error)}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
initializeDatabase(db);
seedTenants(db, tenantSeeds);

const stmtSelectTenantByHash = db.prepare(`
  SELECT id, name
  FROM tenants
  WHERE api_key_hash = ? AND status = 'active'
  LIMIT 1
`);

const stmtDeleteExpiredIdempotency = db.prepare(`
  DELETE FROM idempotency_keys
  WHERE expires_at_ms <= ?
`);

const stmtSelectCachedIdempotency = db.prepare(`
  SELECT request_fingerprint, response_status, response_body
  FROM idempotency_keys
  WHERE tenant_id = ? AND key = ? AND expires_at_ms > ?
  LIMIT 1
`);

const stmtUpsertIdempotency = db.prepare(`
  INSERT INTO idempotency_keys (
    tenant_id,
    key,
    request_fingerprint,
    response_status,
    response_body,
    expires_at_ms,
    created_at_ms
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(tenant_id, key) DO UPDATE SET
    request_fingerprint = excluded.request_fingerprint,
    response_status = excluded.response_status,
    response_body = excluded.response_body,
    expires_at_ms = excluded.expires_at_ms
`);

const idempotencyInflight = new Map<string, InflightEntry>();

function hashApiKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resolveBearerToken(authHeader: unknown): string | null {
  if (typeof authHeader !== "string") {
    return null;
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function resolveTenantIdentity(req: IncomingMessage): TenantIdentity | null {
  const token = resolveBearerToken(req.headers.authorization);
  if (!token) {
    return null;
  }
  const row = stmtSelectTenantByHash.get(hashApiKey(token)) as
    | { id?: unknown; name?: unknown }
    | undefined;
  if (!row) {
    return null;
  }
  const id = typeof row.id === "string" ? row.id : "";
  if (!id) {
    return null;
  }
  const name = typeof row.name === "string" && row.name.trim() ? row.name : id;
  return { id, name };
}

function resolveTenantSeeds(): TenantSeed[] {
  const raw = process.env.MUX_TENANTS_JSON?.trim();
  if (!raw) {
    const apiKey = process.env.MUX_API_KEY || "outbound-secret";
    return [{ id: "tenant-default", name: "default", apiKey }];
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("MUX_TENANTS_JSON must be a non-empty JSON array");
  }

  const seeds: TenantSeed[] = [];
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();

  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      throw new Error("each tenant in MUX_TENANTS_JSON must be an object");
    }
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const apiKey = typeof candidate.apiKey === "string" ? candidate.apiKey.trim() : "";
    const name =
      typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : id;

    if (!id) {
      throw new Error("tenant.id is required");
    }
    if (!apiKey) {
      throw new Error(`tenant.apiKey is required for tenant ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`duplicate tenant.id: ${id}`);
    }
    const keyHash = hashApiKey(apiKey);
    if (seenHashes.has(keyHash)) {
      throw new Error(`duplicate tenant.apiKey detected for tenant ${id}`);
    }

    seenIds.add(id);
    seenHashes.add(keyHash);
    seeds.push({ id, name, apiKey });
  }

  return seeds;
}

function initializeDatabase(database: DatabaseSync) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      route_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      claimed_by_tenant_id TEXT,
      claimed_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pairing_codes_expires ON pairing_codes(expires_at_ms);

    CREATE TABLE IF NOT EXISTS bindings (
      binding_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      scope TEXT NOT NULL,
      route_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bindings_tenant_channel ON bindings(tenant_id, channel);

    CREATE TABLE IF NOT EXISTS session_routes (
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      session_key TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      channel_context_json TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, channel, session_key)
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at_ms);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created
      ON audit_logs(tenant_id, created_at_ms);
  `);
}

function seedTenants(database: DatabaseSync, tenants: TenantSeed[]) {
  const now = Date.now();
  const upsert = database.prepare(`
    INSERT INTO tenants (id, name, api_key_hash, status, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, 'active', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      api_key_hash = excluded.api_key_hash,
      status = 'active',
      updated_at_ms = excluded.updated_at_ms
  `);
  for (const tenant of tenants) {
    upsert.run(tenant.id, tenant.name, hashApiKey(tenant.apiKey), now, now);
  }
}

function log(entry: Record<string, unknown>) {
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): string {
  const bodyText = JSON.stringify(payload);
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(bodyText);
  return bodyText;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<MuxPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw) as MuxPayload;
}

async function sendTelegram(method: "sendMessage" | "sendPhoto", body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, unknown>;
  return { response, result };
}

function purgeExpiredIdempotency(now: number) {
  stmtDeleteExpiredIdempotency.run(now);
}

function resolveInflightKey(tenantId: string, idempotencyKey: string): string {
  return `${tenantId}:${idempotencyKey}`;
}

function loadCachedIdempotency(params: {
  tenantId: string;
  idempotencyKey: string;
  fingerprint: string;
  now: number;
}): SendResult | "mismatch" | null {
  const row = stmtSelectCachedIdempotency.get(params.tenantId, params.idempotencyKey, params.now) as
    | CachedIdempotencyRow
    | undefined;
  if (!row) {
    return null;
  }
  if (row.request_fingerprint !== params.fingerprint) {
    return "mismatch";
  }
  return {
    statusCode: Number(row.response_status),
    bodyText: String(row.response_body),
  };
}

function storeIdempotency(params: {
  tenantId: string;
  idempotencyKey: string;
  fingerprint: string;
  result: SendResult;
  now: number;
}) {
  stmtUpsertIdempotency.run(
    params.tenantId,
    params.idempotencyKey,
    params.fingerprint,
    params.result.statusCode,
    params.result.bodyText,
    params.now + idempotencyTtlMs,
    params.now,
  );
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method !== "POST" || req.url !== "/v1/mux/outbound/send") {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    const tenant = resolveTenantIdentity(req);
    if (!tenant) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const payload = await readBody(req);
    const idempotencyKey =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"]
        : undefined;
    const fingerprint = JSON.stringify(payload);

    const now = Date.now();
    purgeExpiredIdempotency(now);
    if (idempotencyKey) {
      const cached = loadCachedIdempotency({
        tenantId: tenant.id,
        idempotencyKey,
        fingerprint,
        now,
      });
      if (cached === "mismatch") {
        sendJson(res, 409, {
          ok: false,
          error: "idempotency key reused with different payload",
        });
        return;
      }
      if (cached) {
        log({
          type: "idempotency_hit_cached",
          tenantId: tenant.id,
          idempotencyKey,
          status: cached.statusCode,
        });
        res.writeHead(cached.statusCode, { "content-type": "application/json; charset=utf-8" });
        res.end(cached.bodyText);
        return;
      }

      const inflightKey = resolveInflightKey(tenant.id, idempotencyKey);
      const inflight = idempotencyInflight.get(inflightKey);
      if (inflight) {
        if (inflight.fingerprint !== fingerprint) {
          sendJson(res, 409, {
            ok: false,
            error: "idempotency key reused with different payload",
          });
          return;
        }
        const result = await inflight.promise;
        log({
          type: "idempotency_hit_inflight",
          tenantId: tenant.id,
          idempotencyKey,
          status: result.statusCode,
        });
        res.writeHead(result.statusCode, { "content-type": "application/json; charset=utf-8" });
        res.end(result.bodyText);
        return;
      }
    }

    const runSend = async (): Promise<SendResult> => {
      log({
        type: "outbound_request",
        tenantId: tenant.id,
        tenantName: tenant.name,
        idempotencyKey,
        payload,
      });

      const to = String(payload.to || "").trim();
      const text = String(payload.text || "").trim();
      const mediaUrl = String(payload.mediaUrl || "").trim();
      const replyToMessageId = readPositiveInt(payload.replyToId);
      const messageThreadId = readPositiveInt(payload.threadId);

      if (!to) {
        return {
          statusCode: 400,
          bodyText: JSON.stringify({ ok: false, error: "to required" }),
        };
      }
      if (!text && !mediaUrl) {
        return {
          statusCode: 400,
          bodyText: JSON.stringify({ ok: false, error: "text or mediaUrl required" }),
        };
      }

      let method: "sendMessage" | "sendPhoto" = "sendMessage";
      let telegramBody: Record<string, unknown> = { chat_id: to, text };
      if (mediaUrl) {
        method = "sendPhoto";
        telegramBody = { chat_id: to, photo: mediaUrl, caption: text || undefined };
      }
      if (replyToMessageId) {
        telegramBody.reply_to_message_id = replyToMessageId;
      }
      if (messageThreadId) {
        telegramBody.message_thread_id = messageThreadId;
      }

      const { response, result } = await sendTelegram(method, telegramBody);
      log({
        type: "telegram_send_result",
        tenantId: tenant.id,
        method,
        status: response.status,
        result,
      });

      const ok = result.ok === true;
      if (!response.ok || !ok) {
        return {
          statusCode: 502,
          bodyText: JSON.stringify({ ok: false, error: "telegram send failed", details: result }),
        };
      }

      const resultData =
        typeof result.result === "object" && result.result
          ? (result.result as Record<string, unknown>)
          : {};
      const chat =
        typeof resultData.chat === "object" && resultData.chat
          ? (resultData.chat as Record<string, unknown>)
          : {};
      const messageId = String(resultData.message_id ?? "unknown");
      const chatId = String(chat.id ?? to);

      return {
        statusCode: 200,
        bodyText: JSON.stringify({
          ok: true,
          messageId,
          chatId,
          providerMessageIds: [messageId],
        }),
      };
    };

    const inflightKey = idempotencyKey ? resolveInflightKey(tenant.id, idempotencyKey) : undefined;
    const inflightEntry: InflightEntry = { fingerprint, promise: runSend() };
    if (inflightKey) {
      idempotencyInflight.set(inflightKey, inflightEntry);
    }

    const sendResult = await inflightEntry.promise;
    if (inflightKey && idempotencyKey) {
      idempotencyInflight.delete(inflightKey);
      storeIdempotency({
        tenantId: tenant.id,
        idempotencyKey,
        fingerprint,
        result: sendResult,
        now: Date.now(),
      });
    }

    res.writeHead(sendResult.statusCode, { "content-type": "application/json; charset=utf-8" });
    res.end(sendResult.bodyText);
  } catch (error) {
    log({ type: "relay_error", error: String(error) });
    sendJson(res, 500, { ok: false, error: String(error) });
  }
});

server.listen(port, host, () => {
  log({
    type: "relay_started",
    host,
    port,
    dbPath,
    tenantCount: tenantSeeds.length,
  });
  console.log(`mux server listening on http://${host}:${port}`);
});
