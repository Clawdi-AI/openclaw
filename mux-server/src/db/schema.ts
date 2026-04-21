import { DatabaseSync } from "node:sqlite";

export function initializeDatabase(database: DatabaseSync) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      inbound_url TEXT,
      inbound_token TEXT,
      inbound_timeout_ms INTEGER,
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
      channel TEXT,
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
      -- JSON array of alternate routeKeys that also resolve to this binding.
      -- Populated when a binding is healed from a legacy chatJid form (e.g.
      -- <lid>@lid) to a canonical one (<digits>@s.whatsapp.net); the
      -- legacy form is kept here so outbound lookups whose target was frozen
      -- under the old form -- mainly cron delivery.to baked in at job
      -- creation -- still resolve to this binding.
      previous_route_keys TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bindings_tenant_channel ON bindings(tenant_id, channel);
    CREATE INDEX IF NOT EXISTS idx_bindings_channel_route_status
      ON bindings(channel, route_key, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_channel_route_live_unique
      ON bindings(channel, route_key)
      WHERE status IN ('active', 'pending');

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

    CREATE TABLE IF NOT EXISTS discord_offsets (
      binding_id TEXT PRIMARY KEY,
      last_message_id TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_inbound_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      next_attempt_at_ms INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      delivery_window_started_at_ms INTEGER NOT NULL,
      last_target_update_at_ms INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_queue_next_attempt
      ON whatsapp_inbound_queue(next_attempt_at_ms, id);
  `);
  ensureTenantInboundTargetColumns(database);
  ensurePairingTokenColumns(database);
  ensureWhatsAppInboundQueueColumns(database);
  ensureBindingsRouteKeyAliasColumn(database);
}

export function ensureBindingsRouteKeyAliasColumn(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name?: unknown }>;
  const columnNames = new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")));
  if (!columnNames.has("previous_route_keys")) {
    database.exec("ALTER TABLE bindings ADD COLUMN previous_route_keys TEXT NOT NULL DEFAULT '[]'");
  }
}

export function ensureTenantInboundTargetColumns(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(tenants)").all() as Array<{ name?: unknown }>;
  const columnNames = new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")));
  if (!columnNames.has("inbound_url")) {
    database.exec("ALTER TABLE tenants ADD COLUMN inbound_url TEXT");
  }
  if (!columnNames.has("inbound_token")) {
    database.exec("ALTER TABLE tenants ADD COLUMN inbound_token TEXT");
  }
  if (!columnNames.has("inbound_timeout_ms")) {
    database.exec("ALTER TABLE tenants ADD COLUMN inbound_timeout_ms INTEGER");
  }
}

export function ensurePairingTokenColumns(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(pairing_tokens)").all() as Array<{
    name?: unknown;
    notnull?: unknown;
  }>;
  const columnNames = new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")));
  if (!columnNames.has("consumed_binding_id")) {
    database.exec("ALTER TABLE pairing_tokens ADD COLUMN consumed_binding_id TEXT");
  }
  if (!columnNames.has("consumed_route_key")) {
    database.exec("ALTER TABLE pairing_tokens ADD COLUMN consumed_route_key TEXT");
  }

  const channelCol = rows.find((r) => typeof r.name === "string" && r.name === "channel");
  if (channelCol && channelCol.notnull === 1) {
    database.exec(`
      ALTER TABLE pairing_tokens RENAME TO pairing_tokens_old;
      CREATE TABLE pairing_tokens (
        token_hash TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        channel TEXT,
        session_key TEXT,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        consumed_at_ms INTEGER,
        consumed_binding_id TEXT,
        consumed_route_key TEXT
      );
      INSERT INTO pairing_tokens SELECT * FROM pairing_tokens_old;
      DROP TABLE pairing_tokens_old;
    `);
  }
}

export function ensureWhatsAppInboundQueueColumns(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(whatsapp_inbound_queue)").all() as Array<{
    name?: unknown;
  }>;
  const columnNames = new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")));
  if (!columnNames.has("delivery_window_started_at_ms")) {
    database.exec(
      "ALTER TABLE whatsapp_inbound_queue ADD COLUMN delivery_window_started_at_ms INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!columnNames.has("last_target_update_at_ms")) {
    database.exec(
      "ALTER TABLE whatsapp_inbound_queue ADD COLUMN last_target_update_at_ms INTEGER NOT NULL DEFAULT 0",
    );
  }
  database.exec(`
    UPDATE whatsapp_inbound_queue
    SET delivery_window_started_at_ms = created_at_ms
    WHERE delivery_window_started_at_ms <= 0
  `);
}
