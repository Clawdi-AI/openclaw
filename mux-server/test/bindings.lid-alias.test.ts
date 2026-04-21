import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test } from "vitest";
import { initializeDatabase } from "../src/db/schema.js";
import { createPreparedStatements } from "../src/db/statements.js";

// Regression tests for the WhatsApp LID-binding heal + alias resolution
// pathway. The mux-server binds on the first inbound using whatever
// `chatJid` the Baileys bridge emits; historically this was sometimes a
// `<lid>@lid` form and the rest of the pipeline (cron `delivery.to`,
// `persistedLastTo`) froze that LID into its state. Our bridge fix now
// emits the canonical `<digits>@s.whatsapp.net` JID for DMs, but we can't
// bulk-migrate agent-side state, so the mux-server must:
//
//   1. Heal legacy LID-keyed bindings in place on first inbound post-fix,
//      preserving the LID in `previous_route_keys` as an alias.
//   2. Resolve outbound lookups against both `route_key` AND any alias.
//
// These tests pin both behaviors with direct DB writes so they stay
// pinned even when surface-level code moves around.

function seedTenant(db: DatabaseSync, tenantId: string) {
  db.prepare(
    `INSERT INTO tenants (id, name, api_key_hash, status, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 'active', ?, ?)`,
  ).run(tenantId, `Tenant ${tenantId}`, `key-${tenantId}`, Date.now(), Date.now());
}

function seedBinding(
  db: DatabaseSync,
  params: {
    tenantId: string;
    bindingId: string;
    channel: string;
    routeKey: string;
    previousRouteKeys?: string[];
    status?: string;
    scope?: string;
  },
) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO bindings (
       binding_id, tenant_id, channel, scope, route_key,
       previous_route_keys, status, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.bindingId,
    params.tenantId,
    params.channel,
    params.scope ?? "chat",
    params.routeKey,
    JSON.stringify(params.previousRouteKeys ?? []),
    params.status ?? "active",
    now,
    now,
  );
}

describe("WhatsApp binding LID → canonical alias", () => {
  let db: DatabaseSync;
  let stmts: ReturnType<typeof createPreparedStatements>;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initializeDatabase(db);
    stmts = createPreparedStatements(db);
  });

  test("fresh schema starts with empty previous_route_keys default", () => {
    seedTenant(db, "tenant-a");
    const now = Date.now();
    stmts.stmtInsertBinding.run(
      "bind-1",
      "tenant-a",
      "whatsapp",
      "chat",
      "whatsapp:default:chat:15550001111@s.whatsapp.net",
      now,
      now,
    );
    const row = db
      .prepare("SELECT previous_route_keys FROM bindings WHERE binding_id = ?")
      .get("bind-1") as { previous_route_keys?: unknown } | undefined;
    expect(row?.previous_route_keys).toBe("[]");
  });

  test("stmtSelectActiveBindingByTenantAndRoute matches the direct route_key", () => {
    seedTenant(db, "tenant-a");
    seedBinding(db, {
      tenantId: "tenant-a",
      bindingId: "bind-1",
      channel: "whatsapp",
      routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
    });
    const direct = stmts.stmtSelectActiveBindingByTenantAndRoute.get(
      "tenant-a",
      "whatsapp",
      "whatsapp:default:chat:15550001111@s.whatsapp.net",
      "whatsapp:default:chat:15550001111@s.whatsapp.net",
    ) as { binding_id?: unknown } | undefined;
    expect(direct?.binding_id).toBe("bind-1");
  });

  test("stmtSelectActiveBindingByTenantAndRoute matches an alias in previous_route_keys", () => {
    seedTenant(db, "tenant-a");
    // This simulates the post-heal state: binding's `route_key` is the
    // canonical form, and the legacy LID routeKey lives in the alias
    // array. Outbound targets baked under the LID (e.g. existing cron
    // `delivery.to`) must still resolve to this binding.
    seedBinding(db, {
      tenantId: "tenant-a",
      bindingId: "bind-1",
      channel: "whatsapp",
      routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
      previousRouteKeys: ["whatsapp:default:chat:258862678593671@lid"],
    });

    // Lookup via canonical routeKey: hits directly.
    const viaCanonical = stmts.stmtSelectActiveBindingByTenantAndRoute.get(
      "tenant-a",
      "whatsapp",
      "whatsapp:default:chat:15550001111@s.whatsapp.net",
      "whatsapp:default:chat:15550001111@s.whatsapp.net",
    ) as { binding_id?: unknown } | undefined;
    expect(viaCanonical?.binding_id).toBe("bind-1");

    // Lookup via LID alias: also hits.
    const viaLid = stmts.stmtSelectActiveBindingByTenantAndRoute.get(
      "tenant-a",
      "whatsapp",
      "whatsapp:default:chat:258862678593671@lid",
      "whatsapp:default:chat:258862678593671@lid",
    ) as { binding_id?: unknown } | undefined;
    expect(viaLid?.binding_id).toBe("bind-1");
  });

  test("stmtSelectActiveBindingByRouteKey also checks aliases", () => {
    seedTenant(db, "tenant-a");
    seedBinding(db, {
      tenantId: "tenant-a",
      bindingId: "bind-1",
      channel: "whatsapp",
      routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
      previousRouteKeys: ["whatsapp:default:chat:258862678593671@lid"],
    });
    const viaLid = stmts.stmtSelectActiveBindingByRouteKey.get(
      "whatsapp",
      "whatsapp:default:chat:258862678593671@lid",
      "whatsapp:default:chat:258862678593671@lid",
    ) as { binding_id?: unknown } | undefined;
    expect(viaLid?.binding_id).toBe("bind-1");
  });

  test("stmtMigrateBindingRouteKeyWithAlias rewrites route_key and appends to previous_route_keys", () => {
    seedTenant(db, "tenant-a");
    // Pre-heal state: binding stored under legacy LID routeKey.
    const legacyRouteKey = "whatsapp:default:chat:258862678593671@lid";
    const canonicalRouteKey = "whatsapp:default:chat:15550001111@s.whatsapp.net";
    seedBinding(db, {
      tenantId: "tenant-a",
      bindingId: "bind-1",
      channel: "whatsapp",
      routeKey: legacyRouteKey,
    });

    const updatedAt = Date.now();
    stmts.stmtMigrateBindingRouteKeyWithAlias.run(
      canonicalRouteKey,
      legacyRouteKey,
      updatedAt,
      "bind-1",
      "tenant-a",
    );

    const row = db
      .prepare(
        "SELECT route_key, previous_route_keys, updated_at_ms FROM bindings WHERE binding_id = ?",
      )
      .get("bind-1") as
      | {
          route_key?: unknown;
          previous_route_keys?: unknown;
          updated_at_ms?: unknown;
        }
      | undefined;
    expect(row?.route_key).toBe(canonicalRouteKey);
    expect(JSON.parse(String(row?.previous_route_keys))).toEqual([legacyRouteKey]);
    expect(row?.updated_at_ms).toBe(updatedAt);

    // Post-heal: lookup by canonical succeeds on route_key, lookup by
    // legacy LID succeeds via the alias — both resolve to the same binding.
    const viaCanonical = stmts.stmtSelectActiveBindingByTenantAndRoute.get(
      "tenant-a",
      "whatsapp",
      canonicalRouteKey,
      canonicalRouteKey,
    ) as { binding_id?: unknown } | undefined;
    expect(viaCanonical?.binding_id).toBe("bind-1");
    const viaLid = stmts.stmtSelectActiveBindingByTenantAndRoute.get(
      "tenant-a",
      "whatsapp",
      legacyRouteKey,
      legacyRouteKey,
    ) as { binding_id?: unknown } | undefined;
    expect(viaLid?.binding_id).toBe("bind-1");
  });

  test("alias match is scoped to the same tenant (no cross-tenant leakage)", () => {
    seedTenant(db, "tenant-a");
    seedTenant(db, "tenant-b");
    seedBinding(db, {
      tenantId: "tenant-a",
      bindingId: "bind-a",
      channel: "whatsapp",
      routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
      previousRouteKeys: ["whatsapp:default:chat:258862678593671@lid"],
    });
    // Different tenant, no binding for the LID routeKey.
    const otherTenantLookup = stmts.stmtSelectActiveBindingByTenantAndRoute.get(
      "tenant-b",
      "whatsapp",
      "whatsapp:default:chat:258862678593671@lid",
      "whatsapp:default:chat:258862678593671@lid",
    ) as { binding_id?: unknown } | undefined;
    expect(otherTenantLookup).toBeUndefined();
  });

  test("inactive bindings are not resolved even via alias", () => {
    seedTenant(db, "tenant-a");
    seedBinding(db, {
      tenantId: "tenant-a",
      bindingId: "bind-1",
      channel: "whatsapp",
      routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
      previousRouteKeys: ["whatsapp:default:chat:258862678593671@lid"],
      status: "inactive",
    });
    const viaLid = stmts.stmtSelectActiveBindingByTenantAndRoute.get(
      "tenant-a",
      "whatsapp",
      "whatsapp:default:chat:258862678593671@lid",
      "whatsapp:default:chat:258862678593671@lid",
    ) as { binding_id?: unknown } | undefined;
    expect(viaLid).toBeUndefined();
  });

  test("ensureBindingsRouteKeyAliasColumn migrates pre-existing bindings tables", () => {
    // Simulate a deployment that was created before this column existed:
    // drop the fresh-schema table, recreate it without `previous_route_keys`,
    // insert rows, then run the migration and verify the column is added
    // with the default value. Sanity check for the `ALTER TABLE` path.
    const legacyDb = new DatabaseSync(":memory:");
    legacyDb.exec(`
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_key_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE bindings (
        binding_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        scope TEXT NOT NULL,
        route_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    legacyDb
      .prepare(
        `INSERT INTO bindings (binding_id, tenant_id, channel, scope, route_key, created_at_ms, updated_at_ms)
         VALUES ('bind-old', 'tenant-a', 'whatsapp', 'chat', 'whatsapp:default:chat:15550002222@s.whatsapp.net', ?, ?)`,
      )
      .run(now, now);

    // Re-run the bootstrap; this should ALTER TABLE to add the new column.
    initializeDatabase(legacyDb);

    const row = legacyDb
      .prepare("SELECT previous_route_keys FROM bindings WHERE binding_id = ?")
      .get("bind-old") as { previous_route_keys?: unknown } | undefined;
    expect(row?.previous_route_keys).toBe("[]");
  });
});
