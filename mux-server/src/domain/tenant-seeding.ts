import type { DatabaseSync } from "node:sqlite";
import { hashApiKey } from "../auth/service.js";
import { readNonEmptyString, readPositiveInt } from "./values.js";

type TenantSeed = {
  id: string;
  name: string;
  apiKey: string;
  inboundUrl?: string;
  inboundTimeoutMs: number;
};

type PairingCodeSeed = {
  code: string;
  channel: string;
  routeKey: string;
  scope: string;
  expiresAtMs: number;
};

export function createTenantSeedingService(deps: { muxRegisterKey: string | null }) {
  function resolveTenantSeeds(): TenantSeed[] {
    const raw = process.env.MUX_TENANTS_JSON?.trim();
    if (!raw) {
      const apiKey = readNonEmptyString(process.env.MUX_API_KEY);
      if (apiKey) {
        const inboundUrl = readNonEmptyString(process.env.MUX_OPENCLAW_INBOUND_URL) ?? undefined;
        const inboundTimeoutMs =
          readPositiveInt(process.env.MUX_OPENCLAW_INBOUND_TIMEOUT_MS) ?? 15_000;
        return [
          {
            id: "tenant-default",
            name: "default",
            apiKey,
            inboundUrl,
            inboundTimeoutMs,
          },
        ];
      }

      // Instance-centric mode: tenants are created via POST /v1/instances/register.
      if (deps.muxRegisterKey) {
        return [];
      }

      throw new Error("Set MUX_API_KEY, MUX_TENANTS_JSON, or MUX_REGISTER_KEY");
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
      seeds.push({ id, name, apiKey, inboundUrl, inboundTimeoutMs });
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

  function seedTenants(database: DatabaseSync, tenants: TenantSeed[]) {
    const now = Date.now();
    const upsert = database.prepare(`
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
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        api_key_hash = excluded.api_key_hash,
        status = 'active',
        inbound_url = COALESCE(tenants.inbound_url, excluded.inbound_url),
        inbound_token = COALESCE(tenants.inbound_token, excluded.inbound_token),
        inbound_timeout_ms = COALESCE(tenants.inbound_timeout_ms, excluded.inbound_timeout_ms),
        updated_at_ms = excluded.updated_at_ms
    `);
    for (const tenant of tenants) {
      upsert.run(
        tenant.id,
        tenant.name,
        hashApiKey(tenant.apiKey),
        tenant.inboundUrl ?? null,
        tenant.apiKey,
        tenant.inboundTimeoutMs,
        now,
        now,
      );
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

  return {
    resolveTenantSeeds,
    resolvePairingCodeSeeds,
    seedTenants,
    seedPairingCodes,
  };
}
