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
