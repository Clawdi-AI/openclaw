import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import type {
  ClaimResult,
  ClaimType,
  DiscordBoundRoute,
  ExistingBindingRow,
  LiveBindingLookupRow,
  PairingTokenRow,
  TenantIdentity,
} from "../domain/types.js";
import { readNonEmptyString } from "../domain/values.js";

type PairingCodeRow = {
  channel: string;
  route_key: string;
  scope: string;
  expires_at_ms: number;
  claimed_by_tenant_id: string | null;
};

type ActiveBindingRow = {
  binding_id: string;
  channel: string;
  scope: string;
  route_key: string;
};

export function hashPairingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeTtlSec(ttlSec: number, defaultTtlSec: number, maxTtlSec: number): number {
  const safeDefault = Math.max(1, Math.trunc(defaultTtlSec));
  const safeMax = Math.max(safeDefault, Math.trunc(maxTtlSec));
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    return safeDefault;
  }
  return Math.min(Math.max(1, Math.trunc(ttlSec)), safeMax);
}

function generatePairingToken(): string {
  return `mpt_${randomBytes(24).toString("hex")}`;
}

export function createPairingService(deps: {
  dbExec: (sql: string) => void;
  pairingTokenTtlSec: number;
  pairingTokenMaxTtlSec: number;
  discordPendingGcEnabled: boolean;
  telegramBotUsername: string | null;
  buildTelegramRouteKey: (chatId: string, topicId?: number) => string;
  buildDiscordRouteKey: (route: DiscordBoundRoute) => string;
  buildDiscordThreadScopedSessionKey: (baseSessionKey: string, threadId: string) => string;
  buildThreadScopedSessionKey: (baseSessionKey: string, chatId: string, topicId: number) => string;
  buildWhatsAppRouteKey: (chatJid: string, accountId?: string) => string;
  deriveTelegramSessionKey: (chatId: string, topicId?: number) => string;
  deriveDiscordSessionKey: (params: { route: DiscordBoundRoute; channelId: string }) => string;
  deriveWhatsAppSessionKey: (params: {
    chatJid: string;
    chatType: "direct" | "group";
    directPeerId?: string;
  }) => string;
  parseDiscordRouteKey: (routeKey: string) => DiscordBoundRoute | null;
  resolveDiscordBindingRouteKeyForClaim: (params: { incomingRoute: DiscordBoundRoute }) => string;
  resolveDiscordBindingScope: (route: DiscordBoundRoute) => string;
  resolveLiveBindingByRouteKey: (channel: string, routeKey: string) => LiveBindingLookupRow | null;
  stmtDeleteExpiredPairingTokens: StatementSync;
  stmtDeactivateStaleDiscordPendingBindings: StatementSync;
  stmtInsertPairingToken: StatementSync;
  stmtSelectActivePairingTokenByHash: StatementSync;
  stmtSelectPairingCodeByCode: StatementSync;
  stmtClaimPairingCode: StatementSync;
  stmtRevertPairingCodeClaim: StatementSync;
  stmtInsertBinding: StatementSync;
  stmtInsertPendingBinding: StatementSync;
  stmtActivatePendingBinding: StatementSync;
  stmtDeactivateLiveBinding: StatementSync;
  stmtUpsertSessionRoute: StatementSync;
  stmtConsumePairingToken: StatementSync;
  stmtAttachPairingTokenBinding: StatementSync;
  stmtListActiveBindingsByTenant: StatementSync;
  stmtSelectActiveBindingByTenantAndRoute: StatementSync;
  stmtUnbindActiveBinding: StatementSync;
  stmtDeleteSessionRoutesByBinding: StatementSync;
  isRouteBoundByAnotherTenant: (params: {
    channel: string;
    routeKey: string;
    tenantId: string;
  }) => boolean;
  isSqliteUniqueConstraintError: (error: unknown) => boolean;
  writeAuditLog: (
    tenantId: string,
    eventType: string,
    payload: Record<string, unknown>,
    timestampMs?: number,
  ) => void;
}) {
  function purgeExpiredPairingTokens(nowMs: number) {
    deps.stmtDeleteExpiredPairingTokens.run(nowMs);
    if (deps.discordPendingGcEnabled) {
      deps.stmtDeactivateStaleDiscordPendingBindings.run(nowMs, nowMs);
    }
  }

  function runTokenClaimTransaction<T>(claim: () => T | null): T | null {
    deps.dbExec("BEGIN IMMEDIATE");
    try {
      const result = claim();
      if (result === null) {
        deps.dbExec("ROLLBACK");
        return null;
      }
      deps.dbExec("COMMIT");
      return result;
    } catch (error) {
      try {
        deps.dbExec("ROLLBACK");
      } catch {
        // Ignore rollback failures if transaction already closed.
      }
      throw error;
    }
  }

  function issuePairingTokenForTenant(params: {
    tenant: TenantIdentity;
    sessionKey?: string;
    ttlSec?: number;
  }) {
    const nowMs = Date.now();
    purgeExpiredPairingTokens(nowMs);
    const ttlSec = normalizeTtlSec(
      params.ttlSec ?? deps.pairingTokenTtlSec,
      deps.pairingTokenTtlSec,
      deps.pairingTokenMaxTtlSec,
    );
    const token = generatePairingToken();
    const tokenHash = hashPairingToken(token);
    const expiresAtMs = nowMs + ttlSec * 1_000;
    const sessionKey = readNonEmptyString(params.sessionKey);

    deps.stmtInsertPairingToken.run(tokenHash, params.tenant.id, sessionKey, nowMs, expiresAtMs);

    const telegramDeepLink = deps.telegramBotUsername
      ? `https://t.me/${deps.telegramBotUsername}?start=${encodeURIComponent(token)}`
      : null;

    deps.writeAuditLog(
      params.tenant.id,
      "pairing_token_issued",
      {
        expiresAtMs,
        hasSessionKey: Boolean(sessionKey),
      },
      nowMs,
    );

    return {
      statusCode: 200,
      payload: {
        ok: true,
        token,
        expiresAtMs,
        startCommand: `/start ${token}`,
        deepLink: telegramDeepLink,
      },
    };
  }

  function peekActivePairingToken(token: string): PairingTokenRow | null {
    const now = Date.now();
    purgeExpiredPairingTokens(now);
    const tokenHash = hashPairingToken(token);
    const row = deps.stmtSelectActivePairingTokenByHash.get(tokenHash, now) as
      | PairingTokenRow
      | undefined;
    return row ?? null;
  }

  function claimTelegramPairingToken(params: {
    token: string;
    chatId: string;
    topicId?: number;
    chatType: "direct" | "group";
  }): ClaimResult | null {
    return runTokenClaimTransaction(() => {
      const now = Date.now();
      purgeExpiredPairingTokens(now);
      const tokenHash = hashPairingToken(params.token);
      const row = deps.stmtSelectActivePairingTokenByHash.get(tokenHash, now) as
        | PairingTokenRow
        | undefined;
      if (!row) {
        return null;
      }

      const tenantId = String(row.tenant_id);
      const claimRouteKey = deps.buildTelegramRouteKey(params.chatId, params.topicId);
      // Telegram pairing is chat-scoped for both DMs and groups (including forum groups).
      // We still keep topic-specific session routes via claimRouteKey + inbound session mapping.
      const boundRouteKey = deps.buildTelegramRouteKey(params.chatId);

      let claimType: ClaimType = "fresh";
      let previousTenantId: string | undefined;

      const liveBinding = deps.resolveLiveBindingByRouteKey("telegram", boundRouteKey);
      if (liveBinding && liveBinding.tenant_id !== tenantId) {
        // Takeover: different tenant owns this route
        previousTenantId = liveBinding.tenant_id;
        deps.stmtDeactivateLiveBinding.run(now, liveBinding.binding_id, liveBinding.tenant_id);
        deps.stmtDeleteSessionRoutesByBinding.run(liveBinding.binding_id, liveBinding.tenant_id);
        deps.writeAuditLog(
          liveBinding.tenant_id,
          "pairing_unbound_by_route_takeover",
          {
            bindingId: liveBinding.binding_id,
            routeKey: boundRouteKey,
            takeoverTenantId: tenantId,
          },
          now,
        );
        claimType = "takeover";
      }

      const existing = deps.stmtSelectActiveBindingByTenantAndRoute.get(
        tenantId,
        "telegram",
        boundRouteKey,
      ) as ExistingBindingRow | undefined;

      if (existing?.binding_id && existing?.status === "active") {
        // Same tenant already active — re-pair
        const bindingId = String(existing.binding_id);
        const preferredSessionKey = readNonEmptyString(row.session_key);
        const sessionKey =
          params.chatType === "direct" && params.topicId
            ? deps.buildThreadScopedSessionKey(
                preferredSessionKey || deps.deriveTelegramSessionKey(params.chatId),
                params.chatId,
                params.topicId,
              )
            : (preferredSessionKey ?? deps.deriveTelegramSessionKey(params.chatId, params.topicId));
        deps.stmtUpsertSessionRoute.run(
          tenantId,
          "telegram",
          sessionKey,
          bindingId,
          JSON.stringify({ routeKey: claimRouteKey }),
          now,
        );
        const consumeRepaired = deps.stmtConsumePairingToken.run(now, tokenHash, now);
        if (consumeRepaired.changes === 0) {
          return null;
        }
        deps.stmtAttachPairingTokenBinding.run(bindingId, boundRouteKey, tokenHash);
        deps.writeAuditLog(
          tenantId,
          "pairing_token_claimed",
          { bindingId, routeKey: boundRouteKey, claimType: "repaired" },
          now,
        );
        return { tenantId, bindingId, routeKey: boundRouteKey, sessionKey, claimType: "repaired" };
      }

      const bindingId =
        (existing?.binding_id && String(existing.binding_id)) || `bind_${randomUUID()}`;
      if (!existing?.binding_id) {
        try {
          deps.stmtInsertBinding.run(
            bindingId,
            tenantId,
            "telegram",
            boundRouteKey === claimRouteKey && params.topicId ? "topic" : "chat",
            boundRouteKey,
            now,
            now,
          );
        } catch (error) {
          if (deps.isSqliteUniqueConstraintError(error)) {
            return null;
          }
          throw error;
        }
      }

      const preferredSessionKey = readNonEmptyString(row.session_key);
      const sessionKey =
        params.chatType === "direct" && params.topicId
          ? deps.buildThreadScopedSessionKey(
              preferredSessionKey || deps.deriveTelegramSessionKey(params.chatId),
              params.chatId,
              params.topicId,
            )
          : (preferredSessionKey ?? deps.deriveTelegramSessionKey(params.chatId, params.topicId));
      deps.stmtUpsertSessionRoute.run(
        tenantId,
        "telegram",
        sessionKey,
        bindingId,
        JSON.stringify({ routeKey: claimRouteKey }),
        now,
      );

      const consumeResult = deps.stmtConsumePairingToken.run(now, tokenHash, now);
      if (consumeResult.changes === 0) {
        return null;
      }
      deps.stmtAttachPairingTokenBinding.run(bindingId, boundRouteKey, tokenHash);
      deps.writeAuditLog(
        tenantId,
        "pairing_token_claimed",
        {
          bindingId,
          routeKey: boundRouteKey,
          claimType,
          ...(previousTenantId ? { previousTenantId } : {}),
        },
        now,
      );
      return {
        tenantId,
        bindingId,
        routeKey: boundRouteKey,
        sessionKey,
        claimType,
        ...(previousTenantId ? { previousTenantId } : {}),
      };
    });
  }

  function claimDiscordPairingToken(params: {
    token: string;
    route: DiscordBoundRoute;
    channelId: string;
  }): ClaimResult | null {
    return runTokenClaimTransaction(() => {
      const now = Date.now();
      purgeExpiredPairingTokens(now);
      const tokenHash = hashPairingToken(params.token);
      const row = deps.stmtSelectActivePairingTokenByHash.get(tokenHash, now) as
        | PairingTokenRow
        | undefined;
      if (!row) {
        return null;
      }
      const tenantId = String(row.tenant_id);
      if (!tenantId) {
        return null;
      }

      const claimRouteKey = deps.buildDiscordRouteKey(params.route);
      const boundRouteKey = deps.resolveDiscordBindingRouteKeyForClaim({
        incomingRoute: params.route,
      });
      const boundRoute = deps.parseDiscordRouteKey(boundRouteKey);
      if (!boundRoute) {
        return null;
      }

      let claimType: ClaimType = "fresh";
      let previousTenantId: string | undefined;

      const liveBinding = deps.resolveLiveBindingByRouteKey("discord", boundRouteKey);
      if (liveBinding && liveBinding.tenant_id !== tenantId) {
        previousTenantId = liveBinding.tenant_id;
        deps.stmtDeactivateLiveBinding.run(now, liveBinding.binding_id, liveBinding.tenant_id);
        deps.stmtDeleteSessionRoutesByBinding.run(liveBinding.binding_id, liveBinding.tenant_id);
        deps.writeAuditLog(
          liveBinding.tenant_id,
          "pairing_unbound_by_route_takeover",
          {
            bindingId: liveBinding.binding_id,
            routeKey: boundRouteKey,
            takeoverTenantId: tenantId,
          },
          now,
        );
        claimType = "takeover";
      }

      const existing = deps.stmtSelectActiveBindingByTenantAndRoute.get(
        tenantId,
        "discord",
        boundRouteKey,
      ) as ExistingBindingRow | undefined;
      if (existing?.status === "active") {
        // Same tenant already active — re-pair
        const bindingId = String(existing.binding_id);
        const preferredSessionKey = readNonEmptyString(row.session_key);
        const sessionKey =
          params.route.kind === "guild" && params.route.threadId
            ? deps.buildDiscordThreadScopedSessionKey(
                preferredSessionKey ??
                  deps.deriveDiscordSessionKey({
                    route:
                      boundRoute.kind === "guild"
                        ? {
                            kind: "guild",
                            guildId: boundRoute.guildId,
                            ...(boundRoute.channelId ? { channelId: boundRoute.channelId } : {}),
                          }
                        : boundRoute,
                    channelId:
                      boundRoute.kind === "guild"
                        ? (boundRoute.channelId ??
                          (params.route.kind === "guild"
                            ? (params.route.channelId ?? params.channelId)
                            : params.channelId))
                        : params.channelId,
                  }),
                params.route.threadId,
              )
            : (preferredSessionKey ??
              deps.deriveDiscordSessionKey({
                route: params.route,
                channelId: params.channelId,
              }));
        deps.stmtUpsertSessionRoute.run(
          tenantId,
          "discord",
          sessionKey,
          bindingId,
          JSON.stringify({ routeKey: claimRouteKey, channelId: params.channelId }),
          now,
        );
        const consumeRepaired = deps.stmtConsumePairingToken.run(now, tokenHash, now);
        if (consumeRepaired.changes === 0) {
          return null;
        }
        deps.stmtAttachPairingTokenBinding.run(bindingId, boundRouteKey, tokenHash);
        deps.writeAuditLog(
          tenantId,
          "pairing_token_claimed",
          { bindingId, routeKey: boundRouteKey, claimType: "repaired" },
          now,
        );
        return { tenantId, bindingId, routeKey: boundRouteKey, sessionKey, claimType: "repaired" };
      }

      const bindingId =
        (existing?.binding_id && String(existing.binding_id)) || `bind_${randomUUID()}`;
      if (!existing?.binding_id) {
        try {
          deps.stmtInsertPendingBinding.run(
            bindingId,
            tenantId,
            "discord",
            deps.resolveDiscordBindingScope(boundRoute),
            boundRouteKey,
            now,
            now,
          );
        } catch (error) {
          if (deps.isSqliteUniqueConstraintError(error)) {
            return null;
          }
          throw error;
        }
      }

      const activateResult = deps.stmtActivatePendingBinding.run(now, bindingId, tenantId);
      if (activateResult.changes === 0) {
        return null;
      }

      const preferredSessionKey = readNonEmptyString(row.session_key);
      const sessionKey =
        params.route.kind === "guild" && params.route.threadId
          ? deps.buildDiscordThreadScopedSessionKey(
              preferredSessionKey ??
                deps.deriveDiscordSessionKey({
                  route:
                    boundRoute.kind === "guild"
                      ? {
                          kind: "guild",
                          guildId: boundRoute.guildId,
                          ...(boundRoute.channelId ? { channelId: boundRoute.channelId } : {}),
                        }
                      : boundRoute,
                  channelId:
                    boundRoute.kind === "guild"
                      ? (boundRoute.channelId ??
                        (params.route.kind === "guild"
                          ? (params.route.channelId ?? params.channelId)
                          : params.channelId))
                      : params.channelId,
                }),
              params.route.threadId,
            )
          : (preferredSessionKey ??
            deps.deriveDiscordSessionKey({
              route: params.route,
              channelId: params.channelId,
            }));
      deps.stmtUpsertSessionRoute.run(
        tenantId,
        "discord",
        sessionKey,
        bindingId,
        JSON.stringify({ routeKey: claimRouteKey, channelId: params.channelId }),
        now,
      );

      const consumeResult = deps.stmtConsumePairingToken.run(now, tokenHash, now);
      if (consumeResult.changes === 0) {
        return null;
      }
      deps.stmtAttachPairingTokenBinding.run(bindingId, boundRouteKey, tokenHash);
      deps.writeAuditLog(
        tenantId,
        "pairing_token_claimed",
        {
          bindingId,
          routeKey: boundRouteKey,
          claimType,
          ...(previousTenantId ? { previousTenantId } : {}),
        },
        now,
      );
      return {
        tenantId,
        bindingId,
        routeKey: boundRouteKey,
        sessionKey,
        claimType,
        ...(previousTenantId ? { previousTenantId } : {}),
      };
    });
  }

  function claimWhatsAppPairingToken(params: {
    token: string;
    chatJid: string;
    accountId: string;
    chatType: "direct" | "group";
    directPeerId?: string;
  }): ClaimResult | null {
    return runTokenClaimTransaction(() => {
      const now = Date.now();
      purgeExpiredPairingTokens(now);
      const tokenHash = hashPairingToken(params.token);
      const row = deps.stmtSelectActivePairingTokenByHash.get(tokenHash, now) as
        | PairingTokenRow
        | undefined;
      if (!row) {
        return null;
      }

      const tenantId = String(row.tenant_id);
      const routeKey = deps.buildWhatsAppRouteKey(params.chatJid, params.accountId);

      let claimType: ClaimType = "fresh";
      let previousTenantId: string | undefined;

      const liveBinding = deps.resolveLiveBindingByRouteKey("whatsapp", routeKey);
      if (liveBinding && liveBinding.tenant_id !== tenantId) {
        // Takeover: different tenant owns this route
        previousTenantId = liveBinding.tenant_id;
        deps.stmtDeactivateLiveBinding.run(now, liveBinding.binding_id, liveBinding.tenant_id);
        deps.stmtDeleteSessionRoutesByBinding.run(liveBinding.binding_id, liveBinding.tenant_id);
        deps.writeAuditLog(
          liveBinding.tenant_id,
          "pairing_unbound_by_route_takeover",
          {
            bindingId: liveBinding.binding_id,
            routeKey,
            takeoverTenantId: tenantId,
          },
          now,
        );
        claimType = "takeover";
      }

      const existing = deps.stmtSelectActiveBindingByTenantAndRoute.get(
        tenantId,
        "whatsapp",
        routeKey,
      ) as ExistingBindingRow | undefined;

      if (existing?.binding_id && existing?.status === "active") {
        // Same tenant already active — re-pair
        const bindingId = String(existing.binding_id);
        const preferredSessionKey = readNonEmptyString(row.session_key);
        const sessionKey =
          preferredSessionKey ||
          deps.deriveWhatsAppSessionKey({
            chatJid: params.chatJid,
            chatType: params.chatType,
            directPeerId: params.directPeerId,
          });
        deps.stmtUpsertSessionRoute.run(
          tenantId,
          "whatsapp",
          sessionKey,
          bindingId,
          JSON.stringify({
            routeKey,
            accountId: params.accountId,
            chatJid: params.chatJid,
          }),
          now,
        );
        const consumeRepaired = deps.stmtConsumePairingToken.run(now, tokenHash, now);
        if (consumeRepaired.changes === 0) {
          return null;
        }
        deps.stmtAttachPairingTokenBinding.run(bindingId, routeKey, tokenHash);
        deps.writeAuditLog(
          tenantId,
          "pairing_token_claimed",
          { bindingId, routeKey, claimType: "repaired" },
          now,
        );
        return { tenantId, bindingId, routeKey, sessionKey, claimType: "repaired" };
      }

      const bindingId =
        (existing?.binding_id && String(existing.binding_id)) || `bind_${randomUUID()}`;
      if (!existing?.binding_id) {
        try {
          deps.stmtInsertBinding.run(
            bindingId,
            tenantId,
            "whatsapp",
            params.chatType === "group" ? "group" : "chat",
            routeKey,
            now,
            now,
          );
        } catch (error) {
          if (deps.isSqliteUniqueConstraintError(error)) {
            return null;
          }
          throw error;
        }
      }

      const preferredSessionKey = readNonEmptyString(row.session_key);
      const sessionKey =
        preferredSessionKey ||
        deps.deriveWhatsAppSessionKey({
          chatJid: params.chatJid,
          chatType: params.chatType,
          directPeerId: params.directPeerId,
        });
      deps.stmtUpsertSessionRoute.run(
        tenantId,
        "whatsapp",
        sessionKey,
        bindingId,
        JSON.stringify({
          routeKey,
          accountId: params.accountId,
          chatJid: params.chatJid,
        }),
        now,
      );

      const consumeResult = deps.stmtConsumePairingToken.run(now, tokenHash, now);
      if (consumeResult.changes === 0) {
        return null;
      }
      deps.stmtAttachPairingTokenBinding.run(bindingId, routeKey, tokenHash);
      deps.writeAuditLog(
        tenantId,
        "pairing_token_claimed",
        { bindingId, routeKey, claimType, ...(previousTenantId ? { previousTenantId } : {}) },
        now,
      );
      return {
        tenantId,
        bindingId,
        routeKey,
        sessionKey,
        claimType,
        ...(previousTenantId ? { previousTenantId } : {}),
      };
    });
  }

  function claimPairingForTenant(tenant: TenantIdentity, code: string, sessionKey?: string) {
    const now = Date.now();
    const row = deps.stmtSelectPairingCodeByCode.get(code) as PairingCodeRow | undefined;
    if (!row || Number(row.expires_at_ms) <= now) {
      return {
        statusCode: 404,
        payload: { ok: false, error: "pairing code not found or expired" },
      };
    }
    if (row.claimed_by_tenant_id) {
      return { statusCode: 409, payload: { ok: false, error: "pairing code already claimed" } };
    }
    if (
      deps.isRouteBoundByAnotherTenant({
        channel: String(row.channel),
        routeKey: String(row.route_key),
        tenantId: tenant.id,
      })
    ) {
      return { statusCode: 409, payload: { ok: false, error: "route already bound" } };
    }

    const claimResult = deps.stmtClaimPairingCode.run(tenant.id, now, code, now);
    if (claimResult.changes === 0) {
      const postCheck = deps.stmtSelectPairingCodeByCode.get(code) as PairingCodeRow | undefined;
      if (!postCheck || Number(postCheck.expires_at_ms) <= now) {
        return {
          statusCode: 404,
          payload: { ok: false, error: "pairing code not found or expired" },
        };
      }
      return { statusCode: 409, payload: { ok: false, error: "pairing code already claimed" } };
    }

    const bindingId = `bind_${randomUUID()}`;
    try {
      deps.stmtInsertBinding.run(
        bindingId,
        tenant.id,
        String(row.channel),
        String(row.scope),
        String(row.route_key),
        now,
        now,
      );
    } catch (error) {
      if (deps.isSqliteUniqueConstraintError(error)) {
        deps.stmtRevertPairingCodeClaim.run(code, tenant.id);
        return { statusCode: 409, payload: { ok: false, error: "route already bound" } };
      }
      throw error;
    }
    const resolvedSessionKey = readNonEmptyString(sessionKey);
    if (resolvedSessionKey) {
      deps.stmtUpsertSessionRoute.run(
        tenant.id,
        String(row.channel),
        resolvedSessionKey,
        bindingId,
        JSON.stringify({ routeKey: String(row.route_key) }),
        now,
      );
    }
    deps.writeAuditLog(
      tenant.id,
      "pairing_claimed",
      { bindingId, code, routeKey: row.route_key },
      now,
    );
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

  function listPairingsForTenant(tenant: TenantIdentity) {
    const rows = deps.stmtListActiveBindingsByTenant.all(tenant.id) as ActiveBindingRow[];
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
    const unbindResult = deps.stmtUnbindActiveBinding.run(now, bindingId, tenant.id);
    if (unbindResult.changes === 0) {
      return { statusCode: 404, payload: { ok: false, error: "binding not found" } };
    }

    deps.stmtDeleteSessionRoutesByBinding.run(bindingId, tenant.id);
    deps.writeAuditLog(tenant.id, "pairing_unbound", { bindingId }, now);
    return { statusCode: 200, payload: { ok: true } };
  }

  return {
    purgeExpiredPairingTokens,
    runTokenClaimTransaction,
    issuePairingTokenForTenant,
    peekActivePairingToken,
    claimTelegramPairingToken,
    claimDiscordPairingToken,
    claimWhatsAppPairingToken,
    claimPairingForTenant,
    listPairingsForTenant,
    unbindPairingForTenant,
  };
}
