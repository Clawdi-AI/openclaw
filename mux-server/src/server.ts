import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type MuxPayload = {
  channel?: unknown;
  sessionKey?: unknown;
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
  inboundUrl?: string;
  inboundToken?: string;
  inboundTimeoutMs: number;
};

type TenantIdentity = {
  id: string;
  name: string;
};

type PairingCodeSeed = {
  code: string;
  channel: string;
  routeKey: string;
  scope: string;
  expiresAtMs: number;
};

type CachedIdempotencyRow = {
  request_fingerprint: string;
  response_status: number;
  response_body: string;
};

type PairingCodeRow = {
  channel: string;
  route_key: string;
  scope: string;
  expires_at_ms: number;
  claimed_by_tenant_id: string | null;
};

type PairingTokenRow = {
  tenant_id: string;
  channel: string;
  session_key: string | null;
};

type ActiveBindingRow = {
  binding_id: string;
  channel: string;
  scope: string;
  route_key: string;
};

type ExistingBindingRow = {
  binding_id: string;
};

type SessionRouteBindingRow = {
  binding_id: string;
  route_key: string;
};

type ActiveBindingLookupRow = {
  tenant_id: string;
  binding_id: string;
};

type TelegramBoundRoute = {
  chatId: string;
  topicId?: number;
};

type TenantInboundTarget = {
  url: string;
  token: string;
  timeoutMs: number;
};

type TelegramIncomingMessage = {
  message_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  animation?: TelegramAnimation;
  from?: { id?: number };
  chat?: { id?: number; type?: string };
};

type TelegramPhotoSize = {
  file_id?: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
};

type TelegramDocument = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramVideo = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration?: number;
  file_size?: number;
};

type TelegramAnimation = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration?: number;
  file_size?: number;
};

type TelegramInboundAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content: string;
};

type TelegramInboundMediaSummary = {
  kind: string;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  filePath?: string;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramIncomingMessage;
  edited_message?: TelegramIncomingMessage;
};

const host = process.env.MUX_HOST || "127.0.0.1";
const port = Number(process.env.MUX_PORT || 18891);
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const logPath =
  process.env.MUX_LOG_PATH || path.resolve(process.cwd(), "mux-server", "logs", "mux-server.log");
const dbPath =
  process.env.MUX_DB_PATH || path.resolve(process.cwd(), "mux-server", "data", "mux-server.sqlite");
const idempotencyTtlMs = Number(process.env.MUX_IDEMPOTENCY_TTL_MS || 10 * 60 * 1000);
const telegramApiBaseUrl = (
  process.env.MUX_TELEGRAM_API_BASE_URL || "https://api.telegram.org"
).replace(/\/+$/, "");
const telegramInboundEnabled = process.env.MUX_TELEGRAM_INBOUND_ENABLED === "true";
const telegramPollTimeoutSec = Number(process.env.MUX_TELEGRAM_POLL_TIMEOUT_SEC || 25);
const telegramPollRetryMs = Number(process.env.MUX_TELEGRAM_POLL_RETRY_MS || 1_000);
const telegramBootstrapLatest = process.env.MUX_TELEGRAM_BOOTSTRAP_LATEST !== "false";
const telegramInboundMediaMaxBytes = Number(
  process.env.MUX_TELEGRAM_INBOUND_MEDIA_MAX_BYTES || 5_000_000,
);
const pairingTokenTtlSec = Number(process.env.MUX_PAIRING_TOKEN_TTL_SEC || 15 * 60);
const pairingTokenMaxTtlSec = Number(process.env.MUX_PAIRING_TOKEN_MAX_TTL_SEC || 60 * 60);
const telegramBotUsername = readNonEmptyString(process.env.MUX_TELEGRAM_BOT_USERNAME);
const pairingSuccessText =
  readNonEmptyString(process.env.MUX_PAIRING_SUCCESS_TEXT) ||
  "Paired successfully. You can chat now.";
const pairingInvalidText =
  readNonEmptyString(process.env.MUX_PAIRING_INVALID_TEXT) ||
  "Pairing link is invalid or expired. Request a new link from your dashboard.";
const unpairedHintText =
  readNonEmptyString(process.env.MUX_UNPAIRED_HINT_TEXT) ||
  "This chat is not paired yet. Open your dashboard and use a new pairing link.";

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

let pairingCodeSeeds: PairingCodeSeed[] = [];
try {
  pairingCodeSeeds = resolvePairingCodeSeeds();
} catch (error) {
  console.error(`failed to resolve pairing code seeds: ${String(error)}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
initializeDatabase(db);
seedTenants(db, tenantSeeds);
seedPairingCodes(db, pairingCodeSeeds);

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

const stmtSelectPairingCodeByCode = db.prepare(`
  SELECT channel, route_key, scope, expires_at_ms, claimed_by_tenant_id
  FROM pairing_codes
  WHERE code = ?
  LIMIT 1
`);

const stmtClaimPairingCode = db.prepare(`
  UPDATE pairing_codes
  SET claimed_by_tenant_id = ?, claimed_at_ms = ?
  WHERE code = ? AND claimed_by_tenant_id IS NULL AND expires_at_ms > ?
`);

const stmtDeleteExpiredPairingTokens = db.prepare(`
  DELETE FROM pairing_tokens
  WHERE expires_at_ms <= ?
`);

const stmtInsertPairingToken = db.prepare(`
  INSERT INTO pairing_tokens (
    token_hash,
    tenant_id,
    channel,
    session_key,
    created_at_ms,
    expires_at_ms,
    consumed_at_ms,
    consumed_binding_id,
    consumed_route_key
  )
  VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
`);

const stmtSelectActivePairingTokenByHash = db.prepare(`
  SELECT tenant_id, channel, session_key
  FROM pairing_tokens
  WHERE token_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?
  LIMIT 1
`);

const stmtConsumePairingToken = db.prepare(`
  UPDATE pairing_tokens
  SET consumed_at_ms = ?
  WHERE token_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?
`);

const stmtAttachPairingTokenBinding = db.prepare(`
  UPDATE pairing_tokens
  SET consumed_binding_id = ?, consumed_route_key = ?
  WHERE token_hash = ?
`);

const stmtInsertBinding = db.prepare(`
  INSERT INTO bindings (
    binding_id,
    tenant_id,
    channel,
    scope,
    route_key,
    status,
    created_at_ms,
    updated_at_ms
  )
  VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
`);

const stmtListActiveBindingsByTenant = db.prepare(`
  SELECT binding_id, channel, scope, route_key
  FROM bindings
  WHERE tenant_id = ? AND status = 'active'
  ORDER BY created_at_ms DESC
`);

const stmtUnbindActiveBinding = db.prepare(`
  UPDATE bindings
  SET status = 'inactive', updated_at_ms = ?
  WHERE binding_id = ? AND tenant_id = ? AND status = 'active'
`);

const stmtDeleteSessionRoutesByBinding = db.prepare(`
  DELETE FROM session_routes
  WHERE binding_id = ? AND tenant_id = ?
`);

const stmtUpsertSessionRoute = db.prepare(`
  INSERT INTO session_routes (
    tenant_id,
    channel,
    session_key,
    binding_id,
    channel_context_json,
    updated_at_ms
  )
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(tenant_id, channel, session_key) DO UPDATE SET
    binding_id = excluded.binding_id,
    channel_context_json = excluded.channel_context_json,
    updated_at_ms = excluded.updated_at_ms
`);

const stmtResolveSessionRouteBinding = db.prepare(`
  SELECT sr.binding_id, b.route_key
  FROM session_routes sr
  JOIN bindings b ON b.binding_id = sr.binding_id
  WHERE sr.tenant_id = ?
    AND sr.channel = ?
    AND sr.session_key = ?
    AND b.tenant_id = sr.tenant_id
    AND b.channel = sr.channel
    AND b.status = 'active'
  LIMIT 1
`);

const stmtSelectSessionKeyByBinding = db.prepare(`
  SELECT session_key
  FROM session_routes
  WHERE tenant_id = ? AND channel = ? AND binding_id = ?
  ORDER BY updated_at_ms DESC
  LIMIT 1
`);

const stmtSelectActiveBindingByRouteKey = db.prepare(`
  SELECT tenant_id, binding_id
  FROM bindings
  WHERE channel = ? AND route_key = ? AND status = 'active'
  LIMIT 1
`);

const stmtSelectActiveBindingByTenantAndRoute = db.prepare(`
  SELECT binding_id
  FROM bindings
  WHERE tenant_id = ? AND channel = ? AND route_key = ? AND status = 'active'
  ORDER BY updated_at_ms DESC
  LIMIT 1
`);

const stmtSelectTelegramOffset = db.prepare(`
  SELECT last_update_id
  FROM telegram_offsets
  WHERE id = 1
`);

const stmtUpsertTelegramOffset = db.prepare(`
  INSERT INTO telegram_offsets (id, last_update_id, updated_at_ms)
  VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    last_update_id = excluded.last_update_id,
    updated_at_ms = excluded.updated_at_ms
`);

const stmtInsertAuditLog = db.prepare(`
  INSERT INTO audit_logs (tenant_id, event_type, payload_json, created_at_ms)
  VALUES (?, ?, ?, ?)
`);

const idempotencyInflight = new Map<string, InflightEntry>();
const tenantInboundTargets = new Map<string, TenantInboundTarget>();
for (const tenant of tenantSeeds) {
  if (tenant.inboundUrl && tenant.inboundToken) {
    tenantInboundTargets.set(tenant.id, {
      url: tenant.inboundUrl,
      token: tenant.inboundToken,
      timeoutMs: tenant.inboundTimeoutMs,
    });
  }
}

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
    const inboundUrl = readNonEmptyString(process.env.MUX_OPENCLAW_INBOUND_URL) ?? undefined;
    const inboundToken = readNonEmptyString(process.env.MUX_OPENCLAW_INBOUND_TOKEN) ?? undefined;
    const inboundTimeoutMs = readPositiveInt(process.env.MUX_OPENCLAW_INBOUND_TIMEOUT_MS) ?? 15_000;
    return [
      {
        id: "tenant-default",
        name: "default",
        apiKey,
        inboundUrl,
        inboundToken,
        inboundTimeoutMs,
      },
    ];
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
    const inboundUrl =
      typeof candidate.inboundUrl === "string" && candidate.inboundUrl.trim()
        ? candidate.inboundUrl.trim()
        : undefined;
    const inboundToken =
      typeof candidate.inboundToken === "string" && candidate.inboundToken.trim()
        ? candidate.inboundToken.trim()
        : undefined;
    const inboundTimeoutMs =
      typeof candidate.inboundTimeoutMs === "number" &&
      Number.isFinite(candidate.inboundTimeoutMs) &&
      candidate.inboundTimeoutMs > 0
        ? Math.trunc(candidate.inboundTimeoutMs)
        : 15_000;

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
    seeds.push({ id, name, apiKey, inboundUrl, inboundToken, inboundTimeoutMs });
  }

  return seeds;
}

function resolvePairingCodeSeeds(): PairingCodeSeed[] {
  const raw = process.env.MUX_PAIRING_CODES_JSON?.trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("MUX_PAIRING_CODES_JSON must be a JSON array");
  }

  const now = Date.now();
  const seeds: PairingCodeSeed[] = [];
  const seenCodes = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      throw new Error("each pairing code entry must be an object");
    }
    const candidate = item as Record<string, unknown>;
    const code = typeof candidate.code === "string" ? candidate.code.trim() : "";
    const channel = typeof candidate.channel === "string" ? candidate.channel.trim() : "";
    const routeKey = typeof candidate.routeKey === "string" ? candidate.routeKey.trim() : "";
    const scope = typeof candidate.scope === "string" ? candidate.scope.trim() : "";
    const expiresAtMs =
      typeof candidate.expiresAtMs === "number" &&
      Number.isFinite(candidate.expiresAtMs) &&
      candidate.expiresAtMs > 0
        ? Math.trunc(candidate.expiresAtMs)
        : now + 24 * 60 * 60 * 1000;

    if (!code) {
      throw new Error("pairing code entry requires code");
    }
    if (!channel) {
      throw new Error(`pairing code ${code} requires channel`);
    }
    if (!routeKey) {
      throw new Error(`pairing code ${code} requires routeKey`);
    }
    if (!scope) {
      throw new Error(`pairing code ${code} requires scope`);
    }
    if (seenCodes.has(code)) {
      throw new Error(`duplicate pairing code seed: ${code}`);
    }

    seenCodes.add(code);
    seeds.push({ code, channel, routeKey, scope, expiresAtMs });
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

    CREATE TABLE IF NOT EXISTS pairing_tokens (
      token_hash TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      session_key TEXT,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      consumed_at_ms INTEGER,
      consumed_binding_id TEXT,
      consumed_route_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pairing_tokens_tenant_channel
      ON pairing_tokens(tenant_id, channel, expires_at_ms);

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

    CREATE TABLE IF NOT EXISTS telegram_offsets (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_update_id INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
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

function seedPairingCodes(database: DatabaseSync, codes: PairingCodeSeed[]) {
  if (codes.length === 0) {
    return;
  }
  const insert = database.prepare(`
    INSERT INTO pairing_codes (
      code,
      channel,
      route_key,
      scope,
      expires_at_ms,
      claimed_by_tenant_id,
      claimed_at_ms
    )
    VALUES (?, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(code) DO NOTHING
  `);
  for (const code of codes) {
    insert.run(code.code, code.channel, code.routeKey, code.scope, code.expiresAtMs);
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

async function readBody<T extends object>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

async function sendTelegram(method: "sendMessage" | "sendPhoto", body: Record<string, unknown>) {
  const response = await fetch(`${telegramApiBaseUrl}/bot${telegramBotToken}/${method}`, {
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

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTtlSec(ttlSec: number): number {
  const safeDefault = Math.max(1, Math.trunc(pairingTokenTtlSec));
  const safeMax = Math.max(safeDefault, Math.trunc(pairingTokenMaxTtlSec));
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    return safeDefault;
  }
  return Math.min(Math.max(1, Math.trunc(ttlSec)), safeMax);
}

function generatePairingToken(): string {
  return `mpt_${randomBytes(24).toString("base64url")}`;
}

function hashPairingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function purgeExpiredPairingTokens(nowMs: number) {
  stmtDeleteExpiredPairingTokens.run(nowMs);
}

function issuePairingTokenForTenant(params: {
  tenant: TenantIdentity;
  channel: string;
  sessionKey?: string;
  ttlSec?: number;
}) {
  if (params.channel !== "telegram") {
    return {
      statusCode: 400,
      payload: { ok: false, error: "unsupported channel for token pairing" },
    };
  }

  const nowMs = Date.now();
  purgeExpiredPairingTokens(nowMs);
  const ttlSec = normalizeTtlSec(params.ttlSec ?? pairingTokenTtlSec);
  const token = generatePairingToken();
  const tokenHash = hashPairingToken(token);
  const expiresAtMs = nowMs + ttlSec * 1_000;
  const sessionKey = readNonEmptyString(params.sessionKey);

  stmtInsertPairingToken.run(
    tokenHash,
    params.tenant.id,
    params.channel,
    sessionKey,
    nowMs,
    expiresAtMs,
  );

  const deepLink =
    params.channel === "telegram" && telegramBotUsername
      ? `https://t.me/${telegramBotUsername}?start=${encodeURIComponent(token)}`
      : null;

  writeAuditLog(
    params.tenant.id,
    "pairing_token_issued",
    {
      channel: params.channel,
      expiresAtMs,
      hasSessionKey: Boolean(sessionKey),
    },
    nowMs,
  );

  return {
    statusCode: 200,
    payload: {
      ok: true,
      channel: params.channel,
      token,
      expiresAtMs,
      startCommand: params.channel === "telegram" ? `/start ${token}` : null,
      deepLink,
    },
  };
}

function extractTokenFromStartCommand(input: string): string | null {
  const match = input.match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }
  return readNonEmptyString(match[1]);
}

function extractPairingTokenFromTelegramMessage(message: TelegramIncomingMessage): string | null {
  const text = readNonEmptyString(message.text) ?? readNonEmptyString(message.caption);
  if (!text) {
    return null;
  }
  const fromStart = extractTokenFromStartCommand(text);
  if (fromStart && /^mpt_[A-Za-z0-9_-]{20,200}$/.test(fromStart)) {
    return fromStart;
  }
  const direct = text.match(/\b(mpt_[A-Za-z0-9_-]{20,200})\b/);
  return direct?.[1] ?? null;
}

function isTelegramCommandText(input: string | null): boolean {
  if (!input) {
    return false;
  }
  return /^\/[A-Za-z0-9_]+/.test(input.trim());
}

function isImageMimeType(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("image/");
}

function inferImageMimeTypeFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".bmp")) {
    return "image/bmp";
  }
  return undefined;
}

function pickBestTelegramPhotoSize(
  sizes: TelegramPhotoSize[] | undefined,
): TelegramPhotoSize | null {
  if (!Array.isArray(sizes) || sizes.length === 0) {
    return null;
  }
  const candidates = sizes.filter((entry) => readNonEmptyString(entry.file_id));
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => {
    const aSize = readPositiveInt(a.file_size) ?? 0;
    const bSize = readPositiveInt(b.file_size) ?? 0;
    if (aSize !== bSize) {
      return bSize - aSize;
    }
    const aArea = (readPositiveInt(a.width) ?? 0) * (readPositiveInt(a.height) ?? 0);
    const bArea = (readPositiveInt(b.width) ?? 0) * (readPositiveInt(b.height) ?? 0);
    return bArea - aArea;
  });
  return candidates[0] ?? null;
}

async function resolveTelegramFilePath(fileId: string): Promise<string | null> {
  const response = await fetch(`${telegramApiBaseUrl}/bot${telegramBotToken}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!response.ok) {
    return null;
  }
  const result = (await response.json()) as {
    ok?: boolean;
    result?: { file_path?: unknown } | null;
  };
  if (result.ok !== true) {
    return null;
  }
  return readNonEmptyString(result.result?.file_path);
}

async function downloadTelegramFileBase64(filePath: string): Promise<string | null> {
  const normalizedPath = filePath.replace(/^\/+/, "");
  if (!normalizedPath) {
    return null;
  }
  const response = await fetch(
    `${telegramApiBaseUrl}/file/bot${telegramBotToken}/${normalizedPath}`,
  );
  if (!response.ok) {
    return null;
  }
  const maxBytes =
    Number.isFinite(telegramInboundMediaMaxBytes) && telegramInboundMediaMaxBytes > 0
      ? Math.trunc(telegramInboundMediaMaxBytes)
      : 5_000_000;
  const contentLength = readPositiveInt(response.headers.get("content-length"));
  if (contentLength && contentLength > maxBytes) {
    return null;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) {
    return null;
  }
  return buffer.toString("base64");
}

async function resolveTelegramImageAttachment(params: {
  updateId: number;
  kind: string;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  durationSec?: number;
}): Promise<{ attachment?: TelegramInboundAttachment; summary: TelegramInboundMediaSummary }> {
  const summary: TelegramInboundMediaSummary = {
    kind: params.kind,
    fileId: params.fileId,
    fileName: params.fileName,
    mimeType: params.mimeType,
    fileSize: params.fileSize,
    width: params.width,
    height: params.height,
    durationSec: params.durationSec,
  };
  try {
    const filePath = await resolveTelegramFilePath(params.fileId);
    if (!filePath) {
      log({
        type: "telegram_media_get_file_failed",
        updateId: params.updateId,
        fileId: params.fileId,
        kind: params.kind,
      });
      return { summary };
    }
    summary.filePath = filePath;
    const inferredMime = inferImageMimeTypeFromPath(filePath);
    summary.mimeType = inferredMime || summary.mimeType;
    summary.fileName = summary.fileName || path.basename(filePath);
    const content = await downloadTelegramFileBase64(filePath);
    if (!content) {
      log({
        type: "telegram_media_download_failed",
        updateId: params.updateId,
        fileId: params.fileId,
        kind: params.kind,
        filePath,
      });
      return { summary };
    }
    const attachment: TelegramInboundAttachment = {
      type: "image",
      mimeType: summary.mimeType || "image/jpeg",
      fileName: summary.fileName || `${params.kind}-${params.fileId}.jpg`,
      content,
    };
    return { attachment, summary };
  } catch (error) {
    log({
      type: "telegram_media_fetch_error",
      updateId: params.updateId,
      fileId: params.fileId,
      kind: params.kind,
      error: String(error),
    });
    return { summary };
  }
}

async function extractTelegramInboundMedia(params: {
  message: TelegramIncomingMessage;
  updateId: number;
}): Promise<{ attachments: TelegramInboundAttachment[]; media: TelegramInboundMediaSummary[] }> {
  const attachments: TelegramInboundAttachment[] = [];
  const media: TelegramInboundMediaSummary[] = [];

  const bestPhoto = pickBestTelegramPhotoSize(params.message.photo);
  const photoFileId = readNonEmptyString(bestPhoto?.file_id);
  if (photoFileId) {
    const result = await resolveTelegramImageAttachment({
      updateId: params.updateId,
      kind: "photo",
      fileId: photoFileId,
      mimeType: "image/jpeg",
      fileSize: readPositiveInt(bestPhoto?.file_size),
      width: readPositiveInt(bestPhoto?.width),
      height: readPositiveInt(bestPhoto?.height),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  const document = params.message.document;
  const docFileId = readNonEmptyString(document?.file_id);
  const docMimeType = readNonEmptyString(document?.mime_type)?.toLowerCase();
  const docFileName = readNonEmptyString(document?.file_name);
  const docMimeFromPath = inferImageMimeTypeFromPath(docFileName ?? undefined);
  if (docFileId && (isImageMimeType(docMimeType) || Boolean(docMimeFromPath))) {
    const result = await resolveTelegramImageAttachment({
      updateId: params.updateId,
      kind: "document",
      fileId: docFileId,
      fileName: docFileName ?? undefined,
      mimeType: docMimeType ?? docMimeFromPath,
      fileSize: readPositiveInt(document?.file_size),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  const video = params.message.video;
  const videoFileId = readNonEmptyString(video?.file_id);
  if (videoFileId) {
    media.push({
      kind: "video",
      fileId: videoFileId,
      fileName: readNonEmptyString(video?.file_name) ?? undefined,
      mimeType: readNonEmptyString(video?.mime_type)?.toLowerCase() ?? undefined,
      fileSize: readPositiveInt(video?.file_size),
      width: readPositiveInt(video?.width),
      height: readPositiveInt(video?.height),
      durationSec: readPositiveInt(video?.duration),
    });
  }

  const animation = params.message.animation;
  const animationFileId = readNonEmptyString(animation?.file_id);
  if (animationFileId) {
    media.push({
      kind: "animation",
      fileId: animationFileId,
      fileName: readNonEmptyString(animation?.file_name) ?? undefined,
      mimeType: readNonEmptyString(animation?.mime_type)?.toLowerCase() ?? undefined,
      fileSize: readPositiveInt(animation?.file_size),
      width: readPositiveInt(animation?.width),
      height: readPositiveInt(animation?.height),
      durationSec: readPositiveInt(animation?.duration),
    });
  }

  return { attachments, media };
}

async function sendTelegramPairingNotice(params: {
  chatId: string;
  topicId?: number;
  text: string;
}) {
  const body: Record<string, unknown> = {
    chat_id: params.chatId,
    text: params.text,
  };
  if (params.topicId) {
    body.message_thread_id = params.topicId;
  }
  const { response, result } = await sendTelegram("sendMessage", body);
  if (!response.ok || result.ok !== true) {
    throw new Error(`telegram pairing notice failed (${response.status})`);
  }
}

function normalizeChannel(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value.trim().toLowerCase();
}

function parseTelegramRouteKey(routeKey: string): TelegramBoundRoute | null {
  const match = routeKey.match(/^telegram:[^:]+:chat:([^:]+)(?::topic:([^:]+))?$/);
  if (!match) {
    return null;
  }
  const chatId = match[1]?.trim();
  if (!chatId) {
    return null;
  }
  const topicId = readPositiveInt(match[2]);
  return topicId ? { chatId, topicId } : { chatId };
}

function resolveTelegramBoundRoute(params: {
  tenantId: string;
  channel: string;
  sessionKey: string;
}): TelegramBoundRoute | null {
  const row = stmtResolveSessionRouteBinding.get(
    params.tenantId,
    params.channel,
    params.sessionKey,
  ) as SessionRouteBindingRow | undefined;
  if (!row) {
    return null;
  }
  return parseTelegramRouteKey(String(row.route_key));
}

function buildTelegramRouteKey(chatId: string, topicId?: number): string {
  if (topicId) {
    return `telegram:default:chat:${chatId}:topic:${topicId}`;
  }
  return `telegram:default:chat:${chatId}`;
}

function deriveTelegramSessionKey(chatId: string, topicId?: number): string {
  const base = chatId.startsWith("-") ? `tg:group:${chatId}` : `tg:chat:${chatId}`;
  return topicId ? `${base}:thread:${topicId}` : base;
}

function resolveTelegramBindingForIncoming(
  chatId: string,
  topicId?: number,
): { tenantId: string; bindingId: string; routeKey: string } | null {
  const topicRouteKey = topicId ? buildTelegramRouteKey(chatId, topicId) : null;
  if (topicRouteKey) {
    const topicRow = stmtSelectActiveBindingByRouteKey.get("telegram", topicRouteKey) as
      | ActiveBindingLookupRow
      | undefined;
    if (topicRow?.tenant_id && topicRow?.binding_id) {
      return {
        tenantId: String(topicRow.tenant_id),
        bindingId: String(topicRow.binding_id),
        routeKey: topicRouteKey,
      };
    }
  }

  const chatRouteKey = buildTelegramRouteKey(chatId);
  const chatRow = stmtSelectActiveBindingByRouteKey.get("telegram", chatRouteKey) as
    | ActiveBindingLookupRow
    | undefined;
  if (!chatRow?.tenant_id || !chatRow?.binding_id) {
    return null;
  }
  return {
    tenantId: String(chatRow.tenant_id),
    bindingId: String(chatRow.binding_id),
    routeKey: chatRouteKey,
  };
}

function writeAuditLog(
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
  timestampMs = Date.now(),
) {
  stmtInsertAuditLog.run(tenantId, eventType, JSON.stringify(payload), timestampMs);
}

function claimPairingForTenant(tenant: TenantIdentity, code: string, sessionKey?: string) {
  const now = Date.now();
  const row = stmtSelectPairingCodeByCode.get(code) as PairingCodeRow | undefined;
  if (!row || Number(row.expires_at_ms) <= now) {
    return { statusCode: 404, payload: { ok: false, error: "pairing code not found or expired" } };
  }
  if (row.claimed_by_tenant_id) {
    return { statusCode: 409, payload: { ok: false, error: "pairing code already claimed" } };
  }

  const claimResult = stmtClaimPairingCode.run(tenant.id, now, code, now);
  if (claimResult.changes === 0) {
    const postCheck = stmtSelectPairingCodeByCode.get(code) as PairingCodeRow | undefined;
    if (!postCheck || Number(postCheck.expires_at_ms) <= now) {
      return {
        statusCode: 404,
        payload: { ok: false, error: "pairing code not found or expired" },
      };
    }
    return { statusCode: 409, payload: { ok: false, error: "pairing code already claimed" } };
  }

  const bindingId = `bind_${randomUUID()}`;
  stmtInsertBinding.run(
    bindingId,
    tenant.id,
    String(row.channel),
    String(row.scope),
    String(row.route_key),
    now,
    now,
  );
  const resolvedSessionKey = readNonEmptyString(sessionKey);
  if (resolvedSessionKey) {
    stmtUpsertSessionRoute.run(
      tenant.id,
      String(row.channel),
      resolvedSessionKey,
      bindingId,
      JSON.stringify({ routeKey: String(row.route_key) }),
      now,
    );
  }
  writeAuditLog(tenant.id, "pairing_claimed", { bindingId, code, routeKey: row.route_key }, now);
  return {
    statusCode: 200,
    payload: {
      bindingId,
      channel: String(row.channel),
      scope: String(row.scope),
      routeKey: String(row.route_key),
      ...(resolvedSessionKey ? { sessionKey: resolvedSessionKey } : {}),
    },
  };
}

function claimTelegramPairingToken(params: {
  token: string;
  chatId: string;
  topicId?: number;
}): { tenantId: string; bindingId: string; routeKey: string; sessionKey: string } | null {
  const now = Date.now();
  purgeExpiredPairingTokens(now);
  const tokenHash = hashPairingToken(params.token);
  const row = stmtSelectActivePairingTokenByHash.get(tokenHash, now) as PairingTokenRow | undefined;
  if (!row || String(row.channel) !== "telegram") {
    return null;
  }

  const consumeResult = stmtConsumePairingToken.run(now, tokenHash, now);
  if (consumeResult.changes === 0) {
    return null;
  }

  const tenantId = String(row.tenant_id);
  const routeKey = buildTelegramRouteKey(params.chatId, params.topicId);
  const existing = stmtSelectActiveBindingByTenantAndRoute.get(tenantId, "telegram", routeKey) as
    | ExistingBindingRow
    | undefined;

  const bindingId = (existing?.binding_id && String(existing.binding_id)) || `bind_${randomUUID()}`;
  if (!existing?.binding_id) {
    stmtInsertBinding.run(
      bindingId,
      tenantId,
      "telegram",
      params.topicId ? "topic" : "chat",
      routeKey,
      now,
      now,
    );
  }

  const preferredSessionKey = readNonEmptyString(row.session_key);
  const sessionKey = preferredSessionKey || deriveTelegramSessionKey(params.chatId, params.topicId);
  stmtUpsertSessionRoute.run(
    tenantId,
    "telegram",
    sessionKey,
    bindingId,
    JSON.stringify({ routeKey }),
    now,
  );

  stmtAttachPairingTokenBinding.run(bindingId, routeKey, tokenHash);
  writeAuditLog(tenantId, "pairing_token_claimed", { bindingId, routeKey }, now);
  return { tenantId, bindingId, routeKey, sessionKey };
}

function listPairingsForTenant(tenant: TenantIdentity) {
  const rows = stmtListActiveBindingsByTenant.all(tenant.id) as ActiveBindingRow[];
  return {
    statusCode: 200,
    payload: {
      items: rows.map((row) => ({
        bindingId: String(row.binding_id),
        channel: String(row.channel),
        scope: String(row.scope),
        routeKey: String(row.route_key),
      })),
    },
  };
}

function unbindPairingForTenant(tenant: TenantIdentity, bindingId: string) {
  const now = Date.now();
  const unbindResult = stmtUnbindActiveBinding.run(now, bindingId, tenant.id);
  if (unbindResult.changes === 0) {
    return { statusCode: 404, payload: { ok: false, error: "binding not found" } };
  }

  stmtDeleteSessionRoutesByBinding.run(bindingId, tenant.id);
  writeAuditLog(tenant.id, "pairing_unbound", { bindingId }, now);
  return { statusCode: 200, payload: { ok: true } };
}

function resolveStoredTelegramOffset(): number {
  const row = stmtSelectTelegramOffset.get() as { last_update_id?: unknown } | undefined;
  if (!row || typeof row.last_update_id !== "number" || !Number.isFinite(row.last_update_id)) {
    return 0;
  }
  return Math.trunc(row.last_update_id);
}

function storeTelegramOffset(lastUpdateId: number) {
  stmtUpsertTelegramOffset.run(lastUpdateId, Date.now());
}

function extractTelegramMessage(update: TelegramUpdate): TelegramIncomingMessage | null {
  const candidate = update.message ?? update.edited_message;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  return candidate;
}

async function fetchTelegramUpdates(offset: number): Promise<TelegramUpdate[]> {
  const response = await fetch(`${telegramApiBaseUrl}/bot${telegramBotToken}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      offset,
      timeout: Math.max(1, Math.trunc(telegramPollTimeoutSec)),
      allowed_updates: ["message", "edited_message"],
    }),
  });
  if (!response.ok) {
    throw new Error(`telegram getUpdates failed (${response.status})`);
  }
  const json = (await response.json()) as { ok?: boolean; result?: unknown };
  if (json.ok !== true || !Array.isArray(json.result)) {
    throw new Error("telegram getUpdates returned invalid payload");
  }
  return json.result as TelegramUpdate[];
}

async function bootstrapTelegramOffsetIfNeeded() {
  if (!telegramBootstrapLatest) {
    return;
  }
  const current = resolveStoredTelegramOffset();
  if (current > 0) {
    return;
  }
  const response = await fetch(`${telegramApiBaseUrl}/bot${telegramBotToken}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      timeout: 0,
      limit: 1,
      allowed_updates: ["message", "edited_message"],
    }),
  });
  if (!response.ok) {
    throw new Error(`telegram bootstrap getUpdates failed (${response.status})`);
  }
  const json = (await response.json()) as { ok?: boolean; result?: unknown };
  if (json.ok !== true || !Array.isArray(json.result) || json.result.length === 0) {
    return;
  }
  const lastUpdate = json.result[json.result.length - 1] as TelegramUpdate;
  const updateId =
    typeof lastUpdate.update_id === "number" && Number.isFinite(lastUpdate.update_id)
      ? Math.trunc(lastUpdate.update_id)
      : 0;
  if (updateId > 0) {
    storeTelegramOffset(updateId);
  }
}

async function forwardTelegramUpdateToTenant(update: TelegramUpdate) {
  const updateId =
    typeof update.update_id === "number" && Number.isFinite(update.update_id)
      ? Math.trunc(update.update_id)
      : 0;
  if (updateId <= 0) {
    return;
  }

  const message = extractTelegramMessage(update);
  if (!message) {
    return;
  }

  const chatId =
    typeof message.chat?.id === "number" && Number.isFinite(message.chat.id)
      ? String(Math.trunc(message.chat.id))
      : "";
  if (!chatId) {
    return;
  }
  const topicId = readPositiveInt(message.message_thread_id);
  const body = readNonEmptyString(message.text) ?? readNonEmptyString(message.caption);
  const pairingToken = extractPairingTokenFromTelegramMessage(message);
  const binding = resolveTelegramBindingForIncoming(chatId, topicId);
  if (!binding) {
    if (!pairingToken) {
      if (isTelegramCommandText(body)) {
        try {
          await sendTelegramPairingNotice({
            chatId,
            topicId,
            text: unpairedHintText,
          });
        } catch (error) {
          log({
            type: "telegram_unpaired_command_notice_error",
            updateId,
            error: String(error),
          });
        }
      }
      return;
    }
    const claimed = claimTelegramPairingToken({
      token: pairingToken,
      chatId,
      topicId,
    });
    if (!claimed) {
      try {
        await sendTelegramPairingNotice({
          chatId,
          topicId,
          text: pairingInvalidText,
        });
      } catch (error) {
        log({
          type: "telegram_pairing_invalid_notice_error",
          updateId,
          error: String(error),
        });
      }
      log({
        type: "telegram_pairing_token_invalid",
        updateId,
        chatId,
        topicId: topicId ?? null,
      });
      return;
    }

    try {
      await sendTelegramPairingNotice({
        chatId,
        topicId,
        text: pairingSuccessText,
      });
    } catch (error) {
      log({
        type: "telegram_pairing_notice_error",
        tenantId: claimed.tenantId,
        updateId,
        error: String(error),
      });
    }
    log({
      type: "telegram_pairing_token_claimed",
      tenantId: claimed.tenantId,
      updateId,
      routeKey: claimed.routeKey,
      sessionKey: claimed.sessionKey,
    });
    return;
  }
  if (pairingToken) {
    log({
      type: "telegram_pairing_token_ignored_bound_route",
      tenantId: binding.tenantId,
      updateId,
      routeKey: binding.routeKey,
    });
    return;
  }

  const target = tenantInboundTargets.get(binding.tenantId);
  if (!target) {
    log({
      type: "telegram_inbound_drop_no_target",
      tenantId: binding.tenantId,
      updateId,
      routeKey: binding.routeKey,
    });
    return;
  }

  const inboundMedia = await extractTelegramInboundMedia({ message, updateId });
  const forwardedBody = body ?? "";
  if (!forwardedBody && inboundMedia.attachments.length === 0) {
    return;
  }
  const messageId =
    typeof message.message_id === "number" && Number.isFinite(message.message_id)
      ? String(Math.trunc(message.message_id))
      : `tg-msg:${updateId}`;
  const fromId =
    typeof message.from?.id === "number" && Number.isFinite(message.from.id)
      ? String(Math.trunc(message.from.id))
      : "unknown";
  const timestampMs =
    typeof message.date === "number" && Number.isFinite(message.date)
      ? Math.trunc(message.date) * 1_000
      : Date.now();
  const chatType = message.chat?.type === "private" ? "direct" : "group";

  const existingRoute = stmtSelectSessionKeyByBinding.get(
    binding.tenantId,
    "telegram",
    binding.bindingId,
  ) as { session_key?: unknown } | undefined;
  const sessionKey =
    (typeof existingRoute?.session_key === "string" && existingRoute.session_key.trim()) ||
    deriveTelegramSessionKey(chatId, topicId);

  stmtUpsertSessionRoute.run(
    binding.tenantId,
    "telegram",
    sessionKey,
    binding.bindingId,
    JSON.stringify({ routeKey: binding.routeKey }),
    Date.now(),
  );

  const payload = {
    eventId: `tg:${updateId}`,
    channel: "telegram",
    sessionKey,
    body: forwardedBody,
    from: `telegram:${fromId}`,
    to: `telegram:${chatId}`,
    accountId: "default",
    chatType,
    messageId,
    timestampMs,
    threadId: topicId,
    channelData: {
      accountId: "default",
      messageId,
      chatId,
      topicId: topicId ?? null,
      routeKey: binding.routeKey,
      updateId,
      telegram: {
        media: inboundMedia.media,
        rawMessage: message,
        rawUpdate: update,
      },
    },
    ...(inboundMedia.attachments.length > 0 ? { attachments: inboundMedia.attachments } : {}),
  };

  const response = await fetch(target.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(target.timeoutMs),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`openclaw inbound failed (${response.status}): ${bodyText || "no body"}`);
  }

  log({
    type: "telegram_inbound_forwarded",
    tenantId: binding.tenantId,
    sessionKey,
    updateId,
    messageId,
  });
}

async function runTelegramInboundLoop() {
  if (!telegramInboundEnabled) {
    return;
  }

  try {
    await bootstrapTelegramOffsetIfNeeded();
  } catch (error) {
    log({ type: "telegram_inbound_bootstrap_error", error: String(error) });
  }

  let running = true;
  process.on("SIGINT", () => {
    running = false;
  });
  process.on("SIGTERM", () => {
    running = false;
  });

  while (running) {
    try {
      const offset = resolveStoredTelegramOffset() + 1;
      const updates = await fetchTelegramUpdates(offset);
      for (const update of updates) {
        const updateId =
          typeof update.update_id === "number" && Number.isFinite(update.update_id)
            ? Math.trunc(update.update_id)
            : 0;
        if (updateId <= 0) {
          continue;
        }
        try {
          await forwardTelegramUpdateToTenant(update);
        } catch (error) {
          log({ type: "telegram_inbound_forward_error", updateId, error: String(error) });
        } finally {
          storeTelegramOffset(updateId);
        }
      }
    } catch (error) {
      log({ type: "telegram_inbound_poll_error", error: String(error) });
      await new Promise((resolveSleep) =>
        setTimeout(resolveSleep, Math.max(100, Math.trunc(telegramPollRetryMs))),
      );
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;

    if (pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    const tenant = resolveTenantIdentity(req);
    if (!tenant) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && pathname === "/v1/pairings") {
      const result = listPairingsForTenant(tenant);
      sendJson(res, result.statusCode, result.payload);
      return;
    }

    if (req.method === "POST" && pathname === "/v1/pairings/token") {
      const body = await readBody<Record<string, unknown>>(req);
      const channel = normalizeChannel(body.channel);
      if (!channel) {
        sendJson(res, 400, { ok: false, error: "channel required" });
        return;
      }
      const sessionKey = readNonEmptyString(body.sessionKey) ?? undefined;
      const ttlSec = readPositiveInt(body.ttlSec);
      const result = issuePairingTokenForTenant({
        tenant,
        channel,
        sessionKey,
        ttlSec,
      });
      sendJson(res, result.statusCode, result.payload);
      return;
    }

    if (req.method === "POST" && pathname === "/v1/pairings/claim") {
      const body = await readBody<Record<string, unknown>>(req);
      const code = readNonEmptyString(body.code);
      if (!code) {
        sendJson(res, 400, { ok: false, error: "code required" });
        return;
      }
      const sessionKey = readNonEmptyString(body.sessionKey) ?? undefined;
      const result = claimPairingForTenant(tenant, code, sessionKey);
      sendJson(res, result.statusCode, result.payload);
      return;
    }

    if (req.method === "POST" && pathname === "/v1/pairings/unbind") {
      const body = await readBody<Record<string, unknown>>(req);
      const bindingId = readNonEmptyString(body.bindingId);
      if (!bindingId) {
        sendJson(res, 400, { ok: false, error: "bindingId required" });
        return;
      }
      const result = unbindPairingForTenant(tenant, bindingId);
      sendJson(res, result.statusCode, result.payload);
      return;
    }

    if (req.method !== "POST" || pathname !== "/v1/mux/outbound/send") {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    const payload = await readBody<MuxPayload>(req);
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

      const channel = normalizeChannel(payload.channel);
      const sessionKey = readNonEmptyString(payload.sessionKey);
      const text = String(payload.text || "").trim();
      const mediaUrl = String(payload.mediaUrl || "").trim();
      const replyToMessageId = readPositiveInt(payload.replyToId);
      const requestedThreadId = readPositiveInt(payload.threadId);

      if (!channel) {
        return {
          statusCode: 400,
          bodyText: JSON.stringify({ ok: false, error: "channel required" }),
        };
      }
      if (channel !== "telegram") {
        return {
          statusCode: 400,
          bodyText: JSON.stringify({ ok: false, error: "unsupported channel" }),
        };
      }
      if (!sessionKey) {
        return {
          statusCode: 400,
          bodyText: JSON.stringify({ ok: false, error: "sessionKey required" }),
        };
      }

      const boundRoute = resolveTelegramBoundRoute({
        tenantId: tenant.id,
        channel,
        sessionKey,
      });
      if (!boundRoute) {
        return {
          statusCode: 403,
          bodyText: JSON.stringify({
            ok: false,
            error: "route not bound",
            code: "ROUTE_NOT_BOUND",
          }),
        };
      }
      if (!text && !mediaUrl) {
        return {
          statusCode: 400,
          bodyText: JSON.stringify({ ok: false, error: "text or mediaUrl required" }),
        };
      }

      const to = boundRoute.chatId;
      const messageThreadId = requestedThreadId ?? boundRoute.topicId;

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
    pairingCodeSeedCount: pairingCodeSeeds.length,
  });
  console.log(`mux server listening on http://${host}:${port}`);
  if (telegramInboundEnabled) {
    log({
      type: "telegram_inbound_started",
      tenantTargetCount: tenantInboundTargets.size,
      pollTimeoutSec: Math.max(1, Math.trunc(telegramPollTimeoutSec)),
      pollRetryMs: Math.max(100, Math.trunc(telegramPollRetryMs)),
      bootstrapLatest: telegramBootstrapLatest,
    });
    void runTelegramInboundLoop().catch((error) => {
      log({ type: "telegram_inbound_loop_fatal", error: String(error) });
    });
  }
});
