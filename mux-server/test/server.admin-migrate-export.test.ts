import { describe, expect, test } from "vitest";
import * as h from "./server.test.helpers";

/**
 * Tests for `GET /v1/admin/migrate/export-tenant` — the read-side of the
 * flat mux → msg-router migration. See
 * docs/plans/2026-04-20-flat-mux-tenant-migration.md.
 */

async function fetchExport(params: { port: number; adminToken?: string; tenantId?: string }) {
  const query = params.tenantId ? `?tenantId=${encodeURIComponent(params.tenantId)}` : "";
  return await fetch(`http://127.0.0.1:${params.port}/v1/admin/migrate/export-tenant${query}`, {
    method: "GET",
    headers: params.adminToken ? { Authorization: `Bearer ${params.adminToken}` } : undefined,
  });
}

describe("mux server /v1/admin/migrate/export-tenant", () => {
  test("exports an empty dump for a tenant with no bindings", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
    });

    const res = await fetchExport({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      tenantId: "tenant-a",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      dump: {
        schemaVersion: number;
        dumpedAtMs: number;
        tenant: { id: string; name: string };
        bindings: Array<{ channel: string; scope: string; routeKey: string }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.dump.schemaVersion).toBe(1);
    expect(body.dump.tenant).toEqual({ id: "tenant-a", name: "Tenant A" });
    expect(body.dump.bindings).toEqual([]);
    expect(typeof body.dump.dumpedAtMs).toBe("number");
  });

  test("exports the tenant's active bindings", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-EXPORT-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100999",
          scope: "chat",
        },
      ]),
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-EXPORT-1",
      sessionKey: "agent:main:telegram:group:-100999:topic:0",
    });
    expect(claim.status).toBe(200);

    const res = await fetchExport({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      tenantId: "tenant-a",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      dump: {
        bindings: Array<{ channel: string; scope: string; routeKey: string }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.dump.bindings).toEqual([
      {
        channel: "telegram",
        scope: "chat",
        routeKey: "telegram:default:chat:-100999",
      },
    ]);
  });

  test("returns 404 for an unknown tenant", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
    });

    const res = await fetchExport({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      tenantId: "does-not-exist",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "tenant not found" });
  });

  test("returns 400 when tenantId is missing", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
    });

    const res = await fetchExport({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
    });
    expect(res.status).toBe(400);
  });

  test("rejects requests without admin auth", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
    });

    const res = await fetchExport({
      port: server.port,
      tenantId: "tenant-a",
    });
    expect(res.status).toBe(401);
  });
});

async function callMigrate(params: {
  port: number;
  action: "freeze" | "unfreeze" | "finalize";
  tenantId: string;
  adminToken?: string;
}) {
  return await fetch(
    `http://127.0.0.1:${params.port}/v1/admin/migrate/${params.action}-tenant?tenantId=${encodeURIComponent(params.tenantId)}`,
    {
      method: "POST",
      headers: params.adminToken ? { Authorization: `Bearer ${params.adminToken}` } : undefined,
    },
  );
}

describe("mux server migrate freeze/unfreeze/finalize", () => {
  test("freeze → unfreeze round-trips the binding back to active delivery", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-FREEZE-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123",
          scope: "chat",
        },
      ]),
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-FREEZE-1",
      sessionKey: "agent:main:telegram:group:-100123:topic:0",
    });
    expect(claim.status).toBe(200);

    // Freeze: should report one binding frozen.
    const freezeRes = await callMigrate({
      port: server.port,
      action: "freeze",
      tenantId: "tenant-a",
      adminToken: h.DEFAULT_ADMIN_TOKEN,
    });
    expect(freezeRes.status).toBe(200);
    expect(await freezeRes.json()).toEqual({ ok: true, frozen: 1 });

    // Export still works during freeze (read-only, no status filter).
    const exportRes = await fetchExport({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      tenantId: "tenant-a",
    });
    expect(exportRes.status).toBe(200);

    // Tenant-visible bindings list is now empty: mux-server's
    // `listPairingsForTenant` filters on `status='active'`, so frozen
    // bindings don't surface. This is the tenant-facing side effect that
    // matches inbound routing also ignoring frozen rows.
    const listResDuringFreeze = await h.listPairings({
      port: server.port,
      apiKey: "tenant-a-key",
    });
    expect(listResDuringFreeze.status).toBe(200);
    expect(await listResDuringFreeze.json()).toEqual({ items: [] });

    // Idempotent: second freeze is a no-op.
    const freezeAgain = await callMigrate({
      port: server.port,
      action: "freeze",
      tenantId: "tenant-a",
      adminToken: h.DEFAULT_ADMIN_TOKEN,
    });
    expect(await freezeAgain.json()).toEqual({ ok: true, frozen: 0 });

    // Unfreeze restores.
    const unfreezeRes = await callMigrate({
      port: server.port,
      action: "unfreeze",
      tenantId: "tenant-a",
      adminToken: h.DEFAULT_ADMIN_TOKEN,
    });
    expect(unfreezeRes.status).toBe(200);
    expect(await unfreezeRes.json()).toEqual({ ok: true, unfrozen: 1 });

    const listResAfterUnfreeze = await h.listPairings({
      port: server.port,
      apiKey: "tenant-a-key",
    });
    const body = (await listResAfterUnfreeze.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  test("finalize only commits frozen bindings; active bindings untouched", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-FINALIZE-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100456",
          scope: "chat",
        },
      ]),
    });

    await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-FINALIZE-1",
      sessionKey: "agent:main:telegram:group:-100456:topic:0",
    });

    // Without a prior freeze, finalize is a no-op (doesn't touch active).
    const prematureFinalize = await callMigrate({
      port: server.port,
      action: "finalize",
      tenantId: "tenant-a",
      adminToken: h.DEFAULT_ADMIN_TOKEN,
    });
    expect(await prematureFinalize.json()).toEqual({ ok: true, finalized: 0 });

    // Binding still visible — still active.
    const listRes = await h.listPairings({
      port: server.port,
      apiKey: "tenant-a-key",
    });
    expect((await listRes.json()).items).toHaveLength(1);

    // Now freeze → finalize normally.
    await callMigrate({
      port: server.port,
      action: "freeze",
      tenantId: "tenant-a",
      adminToken: h.DEFAULT_ADMIN_TOKEN,
    });
    const finalizeRes = await callMigrate({
      port: server.port,
      action: "finalize",
      tenantId: "tenant-a",
      adminToken: h.DEFAULT_ADMIN_TOKEN,
    });
    expect(await finalizeRes.json()).toEqual({ ok: true, finalized: 1 });

    // Post-finalize, unfreeze is a no-op (no frozen bindings left).
    const unfreezeAfterFinalize = await callMigrate({
      port: server.port,
      action: "unfreeze",
      tenantId: "tenant-a",
      adminToken: h.DEFAULT_ADMIN_TOKEN,
    });
    expect(await unfreezeAfterFinalize.json()).toEqual({ ok: true, unfrozen: 0 });
  });

  test("rejects unauthorized migrate calls", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
    });

    for (const action of ["freeze", "unfreeze", "finalize"] as const) {
      const res = await callMigrate({
        port: server.port,
        action,
        tenantId: "tenant-a",
      });
      expect(res.status).toBe(401);
    }
  });

  test("requires tenantId query param", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/admin/migrate/freeze-tenant`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.DEFAULT_ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(400);
  });
});
