import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { StatementSync } from "node:sqlite";
import type { TenantIdentity, TenantInboundTarget } from "../domain/types.js";
import { readNonEmptyString, readPositiveInt } from "../domain/values.js";
import { hasScope, type RuntimeJwtSigner } from "../runtime-jwt.js";

export function hashApiKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function resolveBearerToken(authHeader: unknown): string | null {
  if (typeof authHeader !== "string") {
    return null;
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function resolveOpenClawIdHeader(req: IncomingMessage): string | null {
  const raw = req.headers["x-openclaw-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return readNonEmptyString(value);
}

export function createAuthService(deps: {
  runtimeJwtSigner: RuntimeJwtSigner;
  runtimeJwtAudienceMux: string;
  stmtSelectTenantById: StatementSync;
  stmtSelectTenantByHash: StatementSync;
  stmtSelectTenantInboundTargetById: StatementSync;
  muxAdminToken: string | null;
  muxRegisterKey: string | null;
}) {
  async function verifyRuntimeJwtForMuxApi(token: string): Promise<TenantIdentity | null> {
    const verified = await deps.runtimeJwtSigner.verify({
      token,
      audience: deps.runtimeJwtAudienceMux,
    });
    if (!verified.ok) {
      return null;
    }
    const payload = verified.payload;
    const sub = readNonEmptyString(payload.sub);
    if (!sub) {
      return null;
    }
    const scopeAllowsRuntime =
      hasScope(payload.scope, "mux:runtime") ||
      hasScope(payload.scope, "mux:outbound") ||
      hasScope(payload.scope, "mux:pairings") ||
      hasScope(payload.scope, "mux:control");
    if (!scopeAllowsRuntime) {
      return null;
    }
    const row = deps.stmtSelectTenantById.get(sub) as { id?: unknown; name?: unknown } | undefined;
    if (!row) {
      return null;
    }
    const id = typeof row.id === "string" ? row.id : "";
    if (!id) {
      return null;
    }
    const name = typeof row.name === "string" && row.name.trim() ? row.name : id;
    return {
      id,
      name,
      authKind: "runtime-jwt",
      authToken: token,
    };
  }

  async function resolveTenantIdentity(req: IncomingMessage): Promise<TenantIdentity | null> {
    const token = resolveBearerToken(req.headers.authorization);
    if (!token) {
      return null;
    }
    const runtimeIdentity = await verifyRuntimeJwtForMuxApi(token);
    if (runtimeIdentity) {
      const headerOpenClawId = resolveOpenClawIdHeader(req);
      if (!headerOpenClawId || headerOpenClawId !== runtimeIdentity.id) {
        return null;
      }
      return runtimeIdentity;
    }
    const row = deps.stmtSelectTenantByHash.get(hashApiKey(token)) as
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
    return { id, name, authKind: "api-key", authToken: token };
  }

  function isAdminAuthorized(req: IncomingMessage): boolean {
    if (!deps.muxAdminToken) {
      return false;
    }
    const token = resolveBearerToken(req.headers.authorization);
    return Boolean(token && token === deps.muxAdminToken);
  }

  function isRegisterAuthorized(req: IncomingMessage): boolean {
    if (!deps.muxRegisterKey) {
      return false;
    }
    const token = resolveBearerToken(req.headers.authorization);
    return Boolean(token && token === deps.muxRegisterKey);
  }

  function resolveTenantInboundTarget(tenantId: string): TenantInboundTarget | null {
    const row = deps.stmtSelectTenantInboundTargetById.get(tenantId) as
      | {
          inbound_url?: unknown;
          inbound_timeout_ms?: unknown;
          updated_at_ms?: unknown;
        }
      | undefined;
    const url = readNonEmptyString(row?.inbound_url);
    if (!url) {
      return null;
    }
    const timeoutMs = readPositiveInt(row?.inbound_timeout_ms) ?? 15_000;
    const updatedAtMs = readPositiveInt(row?.updated_at_ms) ?? null;
    return {
      url,
      timeoutMs,
      openclawId: tenantId,
      updatedAtMs,
    };
  }

  return {
    verifyRuntimeJwtForMuxApi,
    resolveTenantIdentity,
    isAdminAuthorized,
    isRegisterAuthorized,
    resolveTenantInboundTarget,
  };
}
