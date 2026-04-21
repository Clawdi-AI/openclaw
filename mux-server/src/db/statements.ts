import type { DatabaseSync } from "node:sqlite";

export type PreparedStatements = ReturnType<typeof createPreparedStatements>;

export function createPreparedStatements(db: DatabaseSync) {
  const stmtSelectTenantByHash = db.prepare(`
    SELECT id, name
    FROM tenants
    WHERE api_key_hash = ? AND status = 'active'
    LIMIT 1
  `);

  const stmtSelectTenantById = db.prepare(`
    SELECT id, name
    FROM tenants
    WHERE id = ? AND status = 'active'
    LIMIT 1
  `);

  const stmtUpsertTenantByRegister = db.prepare(`
    INSERT INTO tenants (
      id,
      name,
      api_key_hash,
      status,
      inbound_url,
      inbound_token,
      inbound_timeout_ms,
      created_at_ms,
      updated_at_ms
    )
    VALUES (?, ?, ?, 'active', ?, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      api_key_hash = excluded.api_key_hash,
      status = 'active',
      inbound_url = excluded.inbound_url,
      inbound_token = NULL,
      inbound_timeout_ms = excluded.inbound_timeout_ms,
      updated_at_ms = excluded.updated_at_ms
  `);

  const stmtUpsertTenantInboundTargetByAdmin = db.prepare(`
    INSERT INTO tenants (
      id,
      name,
      api_key_hash,
      status,
      inbound_url,
      inbound_token,
      inbound_timeout_ms,
      created_at_ms,
      updated_at_ms
    )
    VALUES (?, ?, ?, 'active', ?, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = 'active',
      inbound_url = excluded.inbound_url,
      inbound_token = NULL,
      inbound_timeout_ms = excluded.inbound_timeout_ms,
      updated_at_ms = excluded.updated_at_ms
  `);

  const stmtSelectTenantInboundTargetById = db.prepare(`
    SELECT inbound_url, inbound_token, inbound_timeout_ms, updated_at_ms
    FROM tenants
    WHERE id = ? AND status = 'active'
    LIMIT 1
  `);

  const stmtCountActiveTenantInboundTargets = db.prepare(`
    SELECT COUNT(*) AS count
    FROM tenants
    WHERE status = 'active'
      AND inbound_url IS NOT NULL
      AND TRIM(inbound_url) <> ''
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

  const stmtRevertPairingCodeClaim = db.prepare(`
    UPDATE pairing_codes
    SET claimed_by_tenant_id = NULL, claimed_at_ms = NULL
    WHERE code = ? AND claimed_by_tenant_id = ?
  `);

  const stmtDeleteExpiredPairingTokens = db.prepare(`
    DELETE FROM pairing_tokens
    WHERE expires_at_ms <= ?
  `);

  const stmtDeactivateStaleDiscordPendingBindings = db.prepare(`
    UPDATE bindings
    SET status = 'inactive', updated_at_ms = ?
    WHERE channel = 'discord'
      AND status = 'pending'
      AND NOT EXISTS (
        SELECT 1
        FROM pairing_tokens pt
        WHERE pt.tenant_id = bindings.tenant_id
          AND pt.consumed_at_ms IS NULL
          AND pt.expires_at_ms > ?
      )
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
    VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)
  `);

  const stmtSelectActivePairingTokenByHash = db.prepare(`
    SELECT tenant_id, session_key
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

  const stmtInsertPendingBinding = db.prepare(`
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
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  const stmtActivatePendingBinding = db.prepare(`
    UPDATE bindings
    SET status = 'active', updated_at_ms = ?
    WHERE binding_id = ? AND tenant_id = ? AND status = 'pending'
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

  const stmtDeactivateLiveBinding = db.prepare(`
    UPDATE bindings
    SET status = 'inactive', updated_at_ms = ?
    WHERE binding_id = ? AND tenant_id = ? AND status IN ('active', 'pending')
  `);

  const stmtSetBindingPending = db.prepare(`
    UPDATE bindings
    SET status = 'pending', updated_at_ms = ?
    WHERE binding_id = ? AND tenant_id = ? AND status IN ('active', 'pending')
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
    SELECT sr.binding_id, b.route_key, sr.channel_context_json
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

  const stmtListSessionRoutesByBinding = db.prepare(`
    SELECT session_key, channel_context_json
    FROM session_routes
    WHERE tenant_id = ? AND channel = ? AND binding_id = ?
    ORDER BY updated_at_ms DESC
  `);

  const stmtSelectSessionKeyByBinding = db.prepare(`
    SELECT session_key
    FROM session_routes
    WHERE tenant_id = ? AND channel = ? AND binding_id = ?
    ORDER BY updated_at_ms DESC
    LIMIT 1
  `);

  // The `OR EXISTS (... json_each(previous_route_keys) ...)` clause lets a
  // binding that has been healed from a legacy chatJid form (e.g. `@lid`)
  // to the canonical form (`@s.whatsapp.net`) still resolve lookups whose
  // caller is holding the legacy routeKey — this is how we keep existing
  // cron `delivery.to` entries (frozen at cron-creation time) working
  // without a bulk openclaw-side migration.
  //
  // Callers pass the search routeKey twice: once for the direct match and
  // once for the alias-existence check. The `json_each` extension is part
  // of the SQLite JSON1 module, built into `node:sqlite`.
  const stmtSelectActiveBindingByRouteKey = db.prepare(`
    SELECT tenant_id, binding_id
    FROM bindings
    WHERE channel = ?
      AND (
        route_key = ?
        OR EXISTS (SELECT 1 FROM json_each(previous_route_keys) WHERE value = ?)
      )
      AND status = 'active'
    ORDER BY updated_at_ms DESC
    LIMIT 1
  `);

  const stmtSelectLiveBindingByRouteKey = db.prepare(`
    SELECT tenant_id, binding_id, status
    FROM bindings
    WHERE channel = ?
      AND (
        route_key = ?
        OR EXISTS (SELECT 1 FROM json_each(previous_route_keys) WHERE value = ?)
      )
      AND status IN ('active', 'pending')
    ORDER BY updated_at_ms DESC
    LIMIT 1
  `);

  const stmtSelectActiveBindingByTenantAndRoute = db.prepare(`
    SELECT binding_id, status
    FROM bindings
    WHERE tenant_id = ?
      AND channel = ?
      AND (
        route_key = ?
        OR EXISTS (SELECT 1 FROM json_each(previous_route_keys) WHERE value = ?)
      )
      AND status IN ('active', 'pending')
    ORDER BY updated_at_ms DESC
    LIMIT 1
  `);

  // Healing statement: rewrite a binding's route_key to the canonical form
  // and push the prior (legacy) routeKey into `previous_route_keys`. Called
  // once per binding, when an inbound arrives at the canonical chatJid for
  // the first time and the canonical lookup missed but the legacy-form
  // lookup hit.
  const stmtMigrateBindingRouteKeyWithAlias = db.prepare(`
    UPDATE bindings
    SET route_key = ?,
        previous_route_keys = json_insert(
          previous_route_keys,
          '$[#]',
          ?
        ),
        updated_at_ms = ?
    WHERE binding_id = ? AND tenant_id = ?
  `);

  const stmtListActiveDiscordBindings = db.prepare(`
    SELECT tenant_id, binding_id, route_key, status
    FROM bindings
    WHERE channel = 'discord' AND status IN ('active', 'pending')
    ORDER BY updated_at_ms ASC
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

  const stmtSelectDiscordOffsetByBinding = db.prepare(`
    SELECT last_message_id
    FROM discord_offsets
    WHERE binding_id = ?
    LIMIT 1
  `);

  const stmtUpsertDiscordOffsetByBinding = db.prepare(`
    INSERT INTO discord_offsets (binding_id, last_message_id, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(binding_id) DO UPDATE SET
      last_message_id = excluded.last_message_id,
      updated_at_ms = excluded.updated_at_ms
  `);

  const stmtInsertWhatsAppInboundQueue = db.prepare(`
    INSERT INTO whatsapp_inbound_queue (
      dedupe_key,
      payload_json,
      next_attempt_at_ms,
      attempt_count,
      last_error,
      delivery_window_started_at_ms,
      last_target_update_at_ms,
      created_at_ms,
      updated_at_ms
    )
    VALUES (?, ?, ?, 0, NULL, ?, 0, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `);

  const stmtSelectDueWhatsAppInboundQueue = db.prepare(`
    SELECT
      id,
      dedupe_key,
      payload_json,
      attempt_count,
      created_at_ms,
      delivery_window_started_at_ms,
      last_target_update_at_ms
    FROM whatsapp_inbound_queue
    WHERE next_attempt_at_ms <= ?
    ORDER BY id ASC
    LIMIT ?
  `);

  const stmtDeleteWhatsAppInboundQueueById = db.prepare(`
    DELETE FROM whatsapp_inbound_queue
    WHERE id = ?
  `);

  const stmtDeferWhatsAppInboundQueueById = db.prepare(`
    UPDATE whatsapp_inbound_queue
    SET
      next_attempt_at_ms = ?,
      attempt_count = ?,
      last_error = ?,
      updated_at_ms = ?,
      delivery_window_started_at_ms = ?,
      last_target_update_at_ms = ?
    WHERE id = ?
  `);

  const stmtCountWhatsAppInboundQueue = db.prepare(`
    SELECT COUNT(*) AS count
    FROM whatsapp_inbound_queue
  `);

  const stmtSelectOldestWhatsAppInboundQueue = db.prepare(`
    SELECT MIN(created_at_ms) AS oldest_created_at_ms
    FROM whatsapp_inbound_queue
  `);

  const stmtInsertAuditLog = db.prepare(`
    INSERT INTO audit_logs (tenant_id, event_type, payload_json, created_at_ms)
    VALUES (?, ?, ?, ?)
  `);

  return {
    stmtSelectTenantByHash,
    stmtSelectTenantById,
    stmtUpsertTenantByRegister,
    stmtUpsertTenantInboundTargetByAdmin,
    stmtSelectTenantInboundTargetById,
    stmtCountActiveTenantInboundTargets,
    stmtDeleteExpiredIdempotency,
    stmtSelectCachedIdempotency,
    stmtUpsertIdempotency,
    stmtSelectPairingCodeByCode,
    stmtClaimPairingCode,
    stmtRevertPairingCodeClaim,
    stmtDeleteExpiredPairingTokens,
    stmtDeactivateStaleDiscordPendingBindings,
    stmtInsertPairingToken,
    stmtSelectActivePairingTokenByHash,
    stmtConsumePairingToken,
    stmtAttachPairingTokenBinding,
    stmtInsertBinding,
    stmtInsertPendingBinding,
    stmtActivatePendingBinding,
    stmtListActiveBindingsByTenant,
    stmtUnbindActiveBinding,
    stmtDeactivateLiveBinding,
    stmtSetBindingPending,
    stmtDeleteSessionRoutesByBinding,
    stmtUpsertSessionRoute,
    stmtResolveSessionRouteBinding,
    stmtListSessionRoutesByBinding,
    stmtSelectSessionKeyByBinding,
    stmtSelectActiveBindingByRouteKey,
    stmtSelectLiveBindingByRouteKey,
    stmtSelectActiveBindingByTenantAndRoute,
    stmtMigrateBindingRouteKeyWithAlias,
    stmtListActiveDiscordBindings,
    stmtSelectTelegramOffset,
    stmtUpsertTelegramOffset,
    stmtSelectDiscordOffsetByBinding,
    stmtUpsertDiscordOffsetByBinding,
    stmtInsertWhatsAppInboundQueue,
    stmtSelectDueWhatsAppInboundQueue,
    stmtDeleteWhatsAppInboundQueueById,
    stmtDeferWhatsAppInboundQueueById,
    stmtCountWhatsAppInboundQueue,
    stmtSelectOldestWhatsAppInboundQueue,
    stmtInsertAuditLog,
  };
}
