import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { inferMimeTypeFromPath } from "../channels/telegram/media.js";
import type { MuxConfig } from "../config/env.js";
import type { TenantIdentity } from "../domain/types.js";
import { readNonEmptyString, readPositiveInt } from "../domain/values.js";
import type { SendResult } from "../outbound/service.js";

type HandledRequest = {
  handled: true;
};

type TenantRequest = {
  handled: false;
  tenant: TenantIdentity;
};

export function createHttpRouteHandler(deps: {
  config: Pick<
    MuxConfig,
    "muxRegisterKey" | "muxAdminToken" | "telegramApiBaseUrl" | "whatsappAllowedFileDirs"
  >;
  getTelegramBotUsername: () => string | null;
  getTelegramPollConflictHealth: () => { lastConflictAtMs: number; lastError: string } | null;
  runtimeJwtSigner: {
    jwks: () => unknown;
  };
  sendJson: (res: ServerResponse, statusCode: number, payload: unknown) => string;
  readBody: <T extends object>(req: IncomingMessage) => Promise<T>;
  metrics: {
    recordAuthFailure: (surface: "register" | "admin" | "tenant") => void;
    recordOutboundRequest: (params: {
      channel: string | null;
      method: string;
      statusCode: number;
      durationMs: number;
    }) => void;
  };
  log: (entry: Record<string, unknown>) => void;
  isRegisterAuthorized: (req: IncomingMessage) => boolean;
  isAdminAuthorized: (req: IncomingMessage) => boolean;
  resolveTenantIdentity: (req: IncomingMessage) => Promise<TenantIdentity | null>;
  buildReadinessReport: (nowMs?: number) => {
    ready: boolean;
    channels: unknown;
    queues: unknown;
    degraded: unknown;
  };
  renderMetricsPayload: () => Promise<string>;
  registerOpenClawInstance: (input: {
    openclawId?: unknown;
    inboundUrl?: unknown;
    inboundTimeoutMs?: unknown;
  }) => Promise<{
    statusCode: number;
    payload: Record<string, unknown>;
  }>;
  getWhatsAppCredentialHealth: () => unknown;
  renderObservabilitySnapshot: (params: {
    nowMs?: number;
    tenantId?: string;
  }) => Record<string, unknown>;
  upsertTenantInboundTargetByAdmin: (params: {
    openclawId: string;
    inboundUrl: string;
    inboundTimeoutMs?: number;
  }) => { ok: true } | { ok: false; statusCode: number; error: string };
  issuePairingTokenForTenant: (params: {
    tenant: TenantIdentity;
    sessionKey?: string;
    ttlSec?: number;
  }) => {
    statusCode: number;
    payload: Record<string, unknown>;
  };
  listPairingsForTenant: (tenant: TenantIdentity) => {
    statusCode: number;
    payload: Record<string, unknown>;
  };
  claimPairingForTenant: (
    tenant: TenantIdentity,
    code: string,
    sessionKey?: string,
  ) => {
    statusCode: number;
    payload: Record<string, unknown>;
  };
  unbindPairingForTenant: (
    tenant: TenantIdentity,
    bindingId: string,
  ) => {
    statusCode: number;
    payload: Record<string, unknown>;
  };
  normalizeChannel: (value: unknown) => string | null;
  runOutboundAction: (params: {
    tenant: TenantIdentity;
    channel: string;
    sessionKey: string;
    action?: string;
  }) => Promise<SendResult>;
  resolveTelegramFilePath: (fileId: string) => Promise<string | null>;
  requireTelegramBotToken: () => string;
  /**
   * Build an opaque dump of a tenant's migration-relevant state — tenant
   * metadata + active bindings — for the flat mux → msg-router migration
   * (see docs/plans/2026-04-20-flat-mux-tenant-migration.md). Returns
   * `null` when the tenant doesn't exist or is inactive.
   */
  exportTenantMigration: (tenantId: string) => {
    schemaVersion: 1;
    dumpedAtMs: number;
    tenant: { id: string; name: string };
    bindings: Array<{ channel: string; scope: string; routeKey: string }>;
  } | null;
}): {
  handleRequest: (params: {
    req: IncomingMessage;
    res: ServerResponse;
    requestUrl: URL;
  }) => Promise<HandledRequest | TenantRequest>;
} {
  async function handleRequest(params: {
    req: IncomingMessage;
    res: ServerResponse;
    requestUrl: URL;
  }): Promise<HandledRequest | TenantRequest> {
    const { req, res, requestUrl } = params;
    const pathname = requestUrl.pathname;

    if (pathname === "/health") {
      const telegramPollConflictHealth = deps.getTelegramPollConflictHealth();
      const telegramInboundHealth = telegramPollConflictHealth
        ? {
            status: "degraded",
            code: "poll_conflict",
            message: "Telegram getUpdates returned 409; another poller is using this bot token.",
            lastConflictAtMs: telegramPollConflictHealth.lastConflictAtMs,
            lastError: telegramPollConflictHealth.lastError,
          }
        : undefined;
      const telegramBotUsername = deps.getTelegramBotUsername();
      deps.sendJson(res, 200, {
        ok: true,
        ...(telegramBotUsername ? { telegramBotUsername } : {}),
        ...(telegramInboundHealth ? { telegramInbound: telegramInboundHealth } : {}),
      });
      return { handled: true };
    }

    if (req.method === "GET" && pathname === "/health/live") {
      deps.sendJson(res, 200, { ok: true, live: true, ts: Date.now() });
      return { handled: true };
    }

    if (req.method === "GET" && pathname === "/health/ready") {
      const readiness = deps.buildReadinessReport(Date.now());
      deps.sendJson(res, readiness.ready ? 200 : 503, {
        ok: readiness.ready,
        ready: readiness.ready,
        channels: readiness.channels,
        queues: readiness.queues,
        degraded: readiness.degraded,
      });
      return { handled: true };
    }

    if (req.method === "GET" && pathname === "/metrics") {
      const body = await deps.renderMetricsPayload();
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
      });
      res.end(body);
      return { handled: true };
    }

    if (req.method === "GET" && pathname === "/.well-known/jwks.json") {
      deps.sendJson(res, 200, deps.runtimeJwtSigner.jwks());
      return { handled: true };
    }

    if (req.method === "POST" && pathname === "/v1/instances/register") {
      if (!deps.config.muxRegisterKey) {
        deps.sendJson(res, 404, { ok: false, error: "not found" });
        return { handled: true };
      }
      if (!deps.isRegisterAuthorized(req)) {
        deps.metrics.recordAuthFailure("register");
        deps.log({ type: "auth_unauthorized", surface: "register" });
        deps.sendJson(res, 401, { ok: false, error: "unauthorized" });
        return { handled: true };
      }
      const body = await deps.readBody<Record<string, unknown>>(req);
      const result = await deps.registerOpenClawInstance({
        openclawId: body.openclawId,
        inboundUrl: body.inboundUrl,
        inboundTimeoutMs: body.inboundTimeoutMs,
      });
      deps.sendJson(res, result.statusCode, result.payload);
      return { handled: true };
    }

    if (req.method === "GET" && pathname === "/v1/admin/info") {
      if (!deps.config.muxAdminToken) {
        deps.sendJson(res, 404, { ok: false, error: "not found" });
        return { handled: true };
      }
      if (!deps.isAdminAuthorized(req)) {
        deps.metrics.recordAuthFailure("admin");
        deps.log({ type: "auth_unauthorized", surface: "admin" });
        deps.sendJson(res, 401, { ok: false, error: "unauthorized" });
        return { handled: true };
      }
      const readiness = deps.buildReadinessReport(Date.now());
      const adminTelegramBotUsername = deps.getTelegramBotUsername();
      deps.sendJson(res, 200, {
        ok: true,
        ...(adminTelegramBotUsername ? { telegramBotUsername: adminTelegramBotUsername } : {}),
        channels: readiness.channels,
        ready: readiness.ready,
        degraded: readiness.degraded,
      });
      return { handled: true };
    }

    if (req.method === "GET" && pathname === "/v1/admin/whatsapp/health") {
      if (!deps.config.muxAdminToken) {
        deps.sendJson(res, 404, { ok: false, error: "not found" });
        return { handled: true };
      }
      if (!deps.isAdminAuthorized(req)) {
        deps.metrics.recordAuthFailure("admin");
        deps.log({ type: "auth_unauthorized", surface: "admin" });
        deps.sendJson(res, 401, { ok: false, error: "unauthorized" });
        return { handled: true };
      }
      deps.sendJson(res, 200, { ok: true, whatsapp: deps.getWhatsAppCredentialHealth() });
      return { handled: true };
    }

    if (req.method === "GET" && pathname === "/v1/admin/observability/snapshot") {
      if (!deps.config.muxAdminToken) {
        deps.sendJson(res, 404, { ok: false, error: "not found" });
        return { handled: true };
      }
      if (!deps.isAdminAuthorized(req)) {
        deps.metrics.recordAuthFailure("admin");
        deps.log({ type: "auth_unauthorized", surface: "admin" });
        deps.sendJson(res, 401, { ok: false, error: "unauthorized" });
        return { handled: true };
      }
      const tenantId = readNonEmptyString(requestUrl.searchParams.get("tenantId"));
      const snapshot = deps.renderObservabilitySnapshot({
        tenantId: tenantId ?? undefined,
      });
      deps.sendJson(res, 200, { ok: true, ...snapshot });
      return { handled: true };
    }

    if (req.method === "POST" && pathname === "/v1/admin/pairings/token") {
      if (!deps.config.muxAdminToken) {
        deps.sendJson(res, 404, { ok: false, error: "not found" });
        return { handled: true };
      }
      if (!deps.isAdminAuthorized(req)) {
        deps.metrics.recordAuthFailure("admin");
        deps.log({ type: "auth_unauthorized", surface: "admin" });
        deps.sendJson(res, 401, { ok: false, error: "unauthorized" });
        return { handled: true };
      }
      const body = await deps.readBody<Record<string, unknown>>(req);
      const openclawId = readNonEmptyString(body.openclawId);
      if (!openclawId) {
        deps.sendJson(res, 400, { ok: false, error: "openclawId required" });
        return { handled: true };
      }
      const sessionKey = readNonEmptyString(body.sessionKey) ?? undefined;
      const ttlSec = readPositiveInt(body.ttlSec);
      const inboundUrl = readNonEmptyString(body.inboundUrl);
      const inboundTimeoutMs = readPositiveInt(body.inboundTimeoutMs);
      if (inboundUrl) {
        const upsert = deps.upsertTenantInboundTargetByAdmin({
          openclawId,
          inboundUrl,
          inboundTimeoutMs,
        });
        if (!upsert.ok) {
          deps.sendJson(res, upsert.statusCode, { ok: false, error: upsert.error });
          return { handled: true };
        }
      }
      const result = deps.issuePairingTokenForTenant({
        tenant: {
          id: openclawId,
          name: openclawId,
          authToken: deps.config.muxAdminToken,
          authKind: "admin",
        },
        sessionKey,
        ttlSec,
      });
      deps.sendJson(res, result.statusCode, result.payload);
      return { handled: true };
    }

    if (req.method === "GET" && pathname === "/v1/admin/migrate/export-tenant") {
      if (!deps.config.muxAdminToken) {
        deps.sendJson(res, 404, { ok: false, error: "not found" });
        return { handled: true };
      }
      if (!deps.isAdminAuthorized(req)) {
        deps.metrics.recordAuthFailure("admin");
        deps.log({ type: "auth_unauthorized", surface: "admin" });
        deps.sendJson(res, 401, { ok: false, error: "unauthorized" });
        return { handled: true };
      }
      const tenantId = readNonEmptyString(requestUrl.searchParams.get("tenantId"));
      if (!tenantId) {
        deps.sendJson(res, 400, { ok: false, error: "tenantId required" });
        return { handled: true };
      }
      const dump = deps.exportTenantMigration(tenantId);
      if (!dump) {
        deps.sendJson(res, 404, { ok: false, error: "tenant not found" });
        return { handled: true };
      }
      deps.sendJson(res, 200, { ok: true, dump });
      return { handled: true };
    }

    const tenant = await deps.resolveTenantIdentity(req);
    if (!tenant) {
      deps.metrics.recordAuthFailure("tenant");
      deps.log({ type: "auth_unauthorized", surface: "tenant" });
      deps.sendJson(res, 401, { ok: false, error: "unauthorized" });
      return { handled: true };
    }

    if (req.method === "GET" && pathname === "/v1/pairings") {
      const result = deps.listPairingsForTenant(tenant);
      deps.sendJson(res, result.statusCode, result.payload);
      return { handled: true };
    }

    if (req.method === "POST" && pathname === "/v1/pairings/claim") {
      const body = await deps.readBody<Record<string, unknown>>(req);
      const code = readNonEmptyString(body.code);
      if (!code) {
        deps.sendJson(res, 400, { ok: false, error: "code required" });
        return { handled: true };
      }
      const sessionKey = readNonEmptyString(body.sessionKey) ?? undefined;
      const result = deps.claimPairingForTenant(tenant, code, sessionKey);
      deps.sendJson(res, result.statusCode, result.payload);
      return { handled: true };
    }

    if (req.method === "POST" && pathname === "/v1/pairings/unbind") {
      const body = await deps.readBody<Record<string, unknown>>(req);
      const bindingId = readNonEmptyString(body.bindingId);
      if (!bindingId) {
        deps.sendJson(res, 400, { ok: false, error: "bindingId required" });
        return { handled: true };
      }
      const result = deps.unbindPairingForTenant(tenant, bindingId);
      deps.sendJson(res, result.statusCode, result.payload);
      return { handled: true };
    }

    if (req.method === "POST" && pathname === "/v1/mux/outbound/typing") {
      const body = await deps.readBody<Record<string, unknown>>(req);
      const channel = deps.normalizeChannel(body.channel);
      const sessionKey = readNonEmptyString(body.sessionKey);
      const payloadOpenClawId = readNonEmptyString(body.openclawId);
      if (!channel) {
        deps.sendJson(res, 400, { ok: false, error: "channel required" });
        return { handled: true };
      }
      if (!sessionKey) {
        deps.sendJson(res, 400, { ok: false, error: "sessionKey required" });
        return { handled: true };
      }
      if (tenant.authKind === "runtime-jwt") {
        if (!payloadOpenClawId || payloadOpenClawId !== tenant.id) {
          deps.metrics.recordAuthFailure("tenant");
          deps.log({
            type: "auth_unauthorized",
            surface: "tenant",
            reason: "openclaw_id_mismatch",
          });
          deps.sendJson(res, 401, { ok: false, error: "openclawId mismatch" });
          return { handled: true };
        }
      }
      const typingStartedAtMs = Date.now();
      const typingResult = await deps.runOutboundAction({
        tenant,
        channel,
        sessionKey,
        action: "typing",
      });
      deps.metrics.recordOutboundRequest({
        channel,
        method: "typing",
        statusCode: typingResult.statusCode,
        durationMs: Date.now() - typingStartedAtMs,
      });
      res.writeHead(typingResult.statusCode, { "content-type": "application/json; charset=utf-8" });
      res.end(typingResult.bodyText);
      return { handled: true };
    }

    if (req.method === "GET" && pathname.startsWith("/v1/mux/files/")) {
      const channel = pathname.slice("/v1/mux/files/".length).toLowerCase();
      if (channel === "telegram") {
        const fileId = requestUrl.searchParams.get("fileId");
        if (!fileId) {
          deps.sendJson(res, 400, { ok: false, error: "fileId query param required" });
          return { handled: true };
        }
        try {
          const filePath = await deps.resolveTelegramFilePath(fileId);
          if (!filePath) {
            deps.sendJson(res, 404, { ok: false, error: "file not found" });
            return { handled: true };
          }
          const token = deps.requireTelegramBotToken();
          const normalizedPath = filePath.replace(/^\/+/, "");
          const upstream = await fetch(
            `${deps.config.telegramApiBaseUrl}/file/bot${token}/${normalizedPath}`,
          );
          if (!upstream.ok || !upstream.body) {
            deps.sendJson(res, 502, { ok: false, error: "upstream fetch failed" });
            return { handled: true };
          }
          const mime =
            inferMimeTypeFromPath(filePath) ||
            upstream.headers.get("content-type") ||
            "application/octet-stream";
          const fileName = path.basename(filePath);
          res.writeHead(200, {
            "content-type": mime,
            "content-disposition": `inline; filename="${fileName}"`,
            ...(upstream.headers.get("content-length")
              ? { "content-length": upstream.headers.get("content-length")! }
              : {}),
          });
          const reader = upstream.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            res.write(value);
          }
          res.end();
        } catch (error) {
          if (!res.headersSent) {
            deps.sendJson(res, 500, { ok: false, error: String(error) });
          }
        }
        return { handled: true };
      }
      if (channel === "whatsapp") {
        const filePath = requestUrl.searchParams.get("path");
        if (!filePath) {
          deps.sendJson(res, 400, { ok: false, error: "path query param required" });
          return { handled: true };
        }
        const resolved = path.resolve(filePath);
        // Prevent path traversal: only serve files within allowed directories.
        const withinAllowed = deps.config.whatsappAllowedFileDirs.some(
          (dir) => resolved === dir || resolved.startsWith(dir + path.sep),
        );
        if (!withinAllowed) {
          deps.sendJson(res, 403, { ok: false, error: "path not within allowed directories" });
          return { handled: true };
        }
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isFile()) {
            deps.sendJson(res, 404, { ok: false, error: "not a file" });
            return { handled: true };
          }
          const mime = inferMimeTypeFromPath(resolved) || "application/octet-stream";
          const fileName = path.basename(resolved);
          res.writeHead(200, {
            "content-type": mime,
            "content-disposition": `inline; filename="${fileName}"`,
            "content-length": String(stat.size),
          });
          fs.createReadStream(resolved).pipe(res);
        } catch (error) {
          deps.log({ type: "whatsapp_file_proxy_error", filePath: resolved, error: String(error) });
          if (!res.headersSent) {
            deps.sendJson(res, 404, { ok: false, error: "file not found" });
          }
        }
        return { handled: true };
      }
      deps.sendJson(res, 400, { ok: false, error: `unsupported channel: ${channel}` });
      return { handled: true };
    }

    if (req.method !== "POST" || pathname !== "/v1/mux/outbound/send") {
      deps.sendJson(res, 404, { ok: false, error: "not found" });
      return { handled: true };
    }

    return {
      handled: false,
      tenant,
    };
  }

  return {
    handleRequest,
  };
}
