import WebSocket from "ws";
import type { MuxConfig } from "../../config/env.js";
import type { PreparedStatements } from "../../db/statements.js";
import type { ClaimResult, DiscordBoundRoute, StyledNotice } from "../../domain/types.js";
import {
  asRecord,
  errorString,
  readNonEmptyString,
  readPositiveInt,
  readUnsignedNumericString,
} from "../../domain/values.js";
import { buildDiscordRouteKey, parseDiscordRouteKey } from "../../routing/keys.js";

type ActiveDiscordBindingRow = {
  tenant_id: string;
  binding_id: string;
  route_key: string;
  status: string;
};

type DiscordRuntimeHealth = {
  pollLoopStartedAtMs: number | null;
  lastPollSuccessAtMs: number | null;
  lastPollErrorAtMs: number | null;
  lastPollError: string | null;
  gatewayLoopStartedAtMs: number | null;
  gatewayReadyAtMs: number | null;
  gatewayLastCloseAtMs: number | null;
  gatewayLastErrorAtMs: number | null;
  gatewayLastError: string | null;
  lastInboundSeenAtMs: number | null;
};

type DiscordBotControlCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "unpair" }
  | { kind: "switch"; token?: string };

type Metrics = {
  recordInboundEvent: (channel: "discord", outcome: "forwarded" | "dropped" | "deferred") => void;
  observeInboundForwardDuration: (channel: "discord", durationMs: number) => void;
  recordActiveUser: (channel: "discord", userId: string) => void;
  recordRetryScheduled: (channel: "discord") => void;
};

export function createDiscordInboundRuntime(deps: {
  config: Pick<
    MuxConfig,
    | "discordApiBaseUrl"
    | "discordInboundEnabled"
    | "discordPollIntervalMs"
    | "discordBootstrapLatest"
    | "discordGatewayDmEnabled"
    | "discordGatewayGuildEnabled"
    | "discordGatewayDefaultIntents"
    | "discordGatewayIntents"
    | "discordGatewayReconnectInitialMs"
    | "discordGatewayReconnectMaxMs"
  >;
  metrics: Metrics;
  discordRuntimeHealth: DiscordRuntimeHealth;
  discordBgRetryCount: Map<string, number>;
  discordBgRetryQueuedAtMs: Map<string, number>;
  getDiscordGatewayReady: () => boolean;
  setDiscordGatewayReady: (ready: boolean) => void;
  getDiscordBotSelfId: () => string | null;
  setDiscordBotSelfId: (botSelfId: string | null) => void;
  requireDiscordBotToken: () => string;
  log: (entry: Record<string, unknown>) => void;
  resolveDiscordInboundChannelId: (route: DiscordBoundRoute) => Promise<string | null>;
  resolveStoredDiscordOffset: (bindingId: string) => string | null;
  storeDiscordOffset: (bindingId: string, lastMessageId: string) => void;
  sortDiscordMessagesAsc: (messages: Record<string, unknown>[]) => Record<string, unknown>[];
  parseBotControlCommand: (input: string) => DiscordBotControlCommand | null;
  handleDiscordBotControlCommand: (params: {
    command: DiscordBotControlCommand;
    channelId: string;
    routeKey: string;
    fromId: string;
    tenantId: string;
    bindingId: string;
    status: "active" | "pending";
  }) => Promise<{ pending?: boolean; routeReset?: boolean }>;
  handleDiscordBotControlCommandUnbound: (params: {
    command: DiscordBotControlCommand;
    channelId: string;
    routeKey: string;
    fromId: string;
  }) => Promise<void>;
  extractPairingTokenFromDiscordMessage: (message: Record<string, unknown>) => string | null;
  peekActivePairingToken: (token: string) => unknown;
  claimDiscordPairingToken: (params: {
    token: string;
    route: DiscordBoundRoute;
    channelId: string;
  }) => ClaimResult | null;
  sendPostClaimNotices: (params: {
    channel: "discord";
    claimed: ClaimResult;
    send: (notice: StyledNotice) => Promise<void>;
    fromId: string;
    chatId: string;
    chatType: "direct" | "group";
  }) => Promise<void>;
  isDiscordCommandText: (input: string) => boolean;
  hasDiscordMessageContent: (message: Record<string, unknown>) => boolean;
  renderUnpairedHintNotice: (channel: "discord") => StyledNotice;
  sendDiscordPairingNotice: (params: { channelId: string; text: string }) => Promise<void>;
  renderPairingInvalidNotice: (channel: "discord") => StyledNotice;
  db: Pick<PreparedStatements, "stmtListActiveDiscordBindings">;
  resolveDiscordIncomingRouteFromMessage: (params: {
    message: Record<string, unknown>;
    fromId: string;
    fallbackRoute?: DiscordBoundRoute;
    fallbackChannelId?: string;
  }) => Promise<{ route: DiscordBoundRoute; channelId: string } | null>;
  resolveDiscordBindingForIncoming: (route: DiscordBoundRoute) => {
    tenantId: string;
    bindingId: string;
    status: "active" | "pending";
    routeKey: string;
  } | null;
  forwardDiscordMessageToTenant: (params: {
    tenantId: string;
    bindingId: string;
    routeKey: string;
    route: DiscordBoundRoute;
    channelId: string;
    message: Record<string, unknown>;
    messageId: string;
    fromId: string;
    body: string;
  }) => Promise<"forwarded" | "ignored" | "deferred">;
  parseDiscordGatewayPayload: (raw: WebSocket.RawData) => Record<string, unknown> | null;
  fetchDiscordGatewayUrl: () => Promise<string>;
}) {
  const DISCORD_BG_RETRY_MAX_PER_TENANT = 3;
  const DISCORD_BG_RETRY_ATTEMPTS = 5;
  const DISCORD_BG_RETRY_INTERVAL_MS = 30_000;

  async function fetchDiscordChannelMessages(params: {
    channelId: string;
    afterMessageId?: string;
    limit?: number;
  }): Promise<Record<string, unknown>[]> {
    const token = deps.requireDiscordBotToken();
    const qs = new URLSearchParams();
    qs.set("limit", String(Math.max(1, Math.min(100, params.limit ?? 50))));
    if (params.afterMessageId) {
      qs.set("after", params.afterMessageId);
    }
    const response = await fetch(
      `${deps.config.discordApiBaseUrl}/channels/${params.channelId}/messages?${qs}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
    const bodyText = await response.text();
    let parsed: unknown = [];
    if (bodyText.trim()) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = [];
      }
    }
    if (!response.ok) {
      throw new Error(`discord list messages failed (${response.status})`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("discord list messages returned invalid payload");
    }
    return parsed.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    );
  }

  async function sendDiscordClaimNotices(params: {
    claimed: ClaimResult;
    channelId: string;
    fromId: string;
    route: DiscordBoundRoute;
    messageId: string;
  }) {
    try {
      await deps.sendPostClaimNotices({
        channel: "discord",
        claimed: params.claimed,
        send: async (notice) => {
          await deps.sendDiscordPairingNotice({
            channelId: params.channelId,
            text: notice.text,
          });
        },
        fromId: params.fromId,
        chatId: params.channelId,
        chatType: params.route.kind === "dm" ? "direct" : "group",
      });
    } catch (error) {
      deps.log({
        type: "discord_pairing_notice_error",
        tenantId: params.claimed.tenantId,
        bindingId: params.claimed.bindingId,
        messageId: params.messageId,
        error: String(error),
      });
    }
    deps.log({
      type: "discord_pairing_token_claimed",
      tenantId: params.claimed.tenantId,
      bindingId: params.claimed.bindingId,
      routeKey: params.claimed.routeKey,
      sessionKey: params.claimed.sessionKey,
      claimType: params.claimed.claimType,
      ...(params.claimed.previousTenantId
        ? { previousTenantId: params.claimed.previousTenantId }
        : {}),
      channelId: params.channelId,
      messageId: params.messageId,
    });
  }

  async function forwardDiscordBindingInbound(params: ActiveDiscordBindingRow) {
    const route = parseDiscordRouteKey(params.route_key);
    if (!route) {
      return;
    }
    let pending = params.status === "pending";

    const channelId = await deps.resolveDiscordInboundChannelId(route);
    if (!channelId) {
      deps.log({
        type: "discord_inbound_skip_unresolvable_route",
        tenantId: params.tenant_id,
        bindingId: params.binding_id,
        routeKey: params.route_key,
      });
      return;
    }

    const existingOffset = deps.resolveStoredDiscordOffset(params.binding_id);
    if (!existingOffset && deps.config.discordBootstrapLatest) {
      const latest = await fetchDiscordChannelMessages({ channelId, limit: 1 });
      const last = latest[0];
      const lastMessageId = readUnsignedNumericString(last?.id);
      if (lastMessageId) {
        deps.storeDiscordOffset(params.binding_id, lastMessageId);
      }
      return;
    }

    const updates = await fetchDiscordChannelMessages({
      channelId,
      afterMessageId: existingOffset ?? undefined,
      limit: 50,
    });
    if (updates.length === 0) {
      return;
    }

    const sorted = deps.sortDiscordMessagesAsc(updates);
    let lastAckedMessageId = existingOffset ?? null;

    for (const message of sorted) {
      const messageId = readUnsignedNumericString(message.id);
      if (!messageId) {
        continue;
      }

      const author =
        message.author && typeof message.author === "object"
          ? (message.author as Record<string, unknown>)
          : undefined;
      const fromId = readUnsignedNumericString(author?.id);
      const isBot = author?.bot === true;
      if (!fromId || isBot) {
        lastAckedMessageId = messageId;
        continue;
      }

      const body = typeof message.content === "string" ? message.content : "";
      const botControlCommand = deps.parseBotControlCommand(body);
      if (botControlCommand) {
        try {
          const result = await deps.handleDiscordBotControlCommand({
            command: botControlCommand,
            channelId,
            routeKey: params.route_key,
            fromId,
            tenantId: params.tenant_id,
            bindingId: params.binding_id,
            status: pending ? "pending" : "active",
          });
          lastAckedMessageId = messageId;
          if (typeof result.pending === "boolean") {
            pending = result.pending;
          }
          if (result.routeReset) {
            break;
          }
        } catch (error) {
          deps.log({
            type: "discord_bot_control_error",
            tenantId: params.tenant_id,
            bindingId: params.binding_id,
            routeKey: params.route_key,
            messageId,
            error: String(error),
          });
        }
        continue;
      }

      const pairingToken = deps.extractPairingTokenFromDiscordMessage(message);
      if (pending) {
        if (!pairingToken) {
          const shouldSendUnpairedNotice =
            deps.isDiscordCommandText(body) ||
            (route.kind === "dm" && deps.hasDiscordMessageContent(message));
          if (shouldSendUnpairedNotice) {
            try {
              const notice = deps.renderUnpairedHintNotice("discord");
              await deps.sendDiscordPairingNotice({
                channelId,
                text: notice.text,
              });
            } catch (error) {
              deps.log({
                type: "discord_unpaired_command_notice_error",
                tenantId: params.tenant_id,
                bindingId: params.binding_id,
                messageId,
                error: String(error),
              });
            }
          }
          lastAckedMessageId = messageId;
          continue;
        }

        const tokenRow = deps.peekActivePairingToken(pairingToken);
        if (!tokenRow) {
          try {
            const notice = deps.renderPairingInvalidNotice("discord");
            await deps.sendDiscordPairingNotice({
              channelId,
              text: notice.text,
            });
          } catch (error) {
            deps.log({
              type: "discord_pairing_invalid_notice_error",
              tenantId: params.tenant_id,
              bindingId: params.binding_id,
              messageId,
              error: String(error),
            });
          }
          deps.log({
            type: "discord_pairing_token_invalid",
            tenantId: params.tenant_id,
            bindingId: params.binding_id,
            messageId,
            channelId,
          });
          lastAckedMessageId = messageId;
          continue;
        }

        const claimed = deps.claimDiscordPairingToken({
          token: pairingToken,
          route,
          channelId,
        });
        if (!claimed) {
          try {
            const notice = deps.renderPairingInvalidNotice("discord");
            await deps.sendDiscordPairingNotice({
              channelId,
              text: notice.text,
            });
          } catch (error) {
            deps.log({
              type: "discord_pairing_invalid_notice_error",
              tenantId: params.tenant_id,
              bindingId: params.binding_id,
              messageId,
              error: String(error),
            });
          }
          deps.log({
            type: "discord_pairing_token_invalid",
            tenantId: params.tenant_id,
            bindingId: params.binding_id,
            messageId,
            channelId,
          });
          lastAckedMessageId = messageId;
          continue;
        }

        await sendDiscordClaimNotices({
          claimed,
          channelId,
          fromId,
          route,
          messageId,
        });
        pending = false;
        lastAckedMessageId = messageId;
        continue;
      }

      if (pairingToken) {
        const reClaimed = deps.claimDiscordPairingToken({
          token: pairingToken,
          route,
          channelId,
        });
        if (reClaimed) {
          await sendDiscordClaimNotices({
            claimed: reClaimed,
            channelId,
            fromId,
            route,
            messageId,
          });
        } else {
          deps.log({
            type: "discord_pairing_token_ignored_bound_route",
            tenantId: params.tenant_id,
            bindingId: params.binding_id,
            routeKey: params.route_key,
            messageId,
          });
        }
        lastAckedMessageId = messageId;
        continue;
      }

      const forwardStatus = await deps.forwardDiscordMessageToTenant({
        tenantId: params.tenant_id,
        bindingId: params.binding_id,
        routeKey: params.route_key,
        route,
        channelId,
        message,
        messageId,
        fromId,
        body,
      });
      if (forwardStatus === "deferred") {
        break;
      }
      lastAckedMessageId = messageId;
    }

    if (lastAckedMessageId && lastAckedMessageId !== existingOffset) {
      deps.storeDiscordOffset(params.binding_id, lastAckedMessageId);
      deps.log({
        type: "discord_inbound_ack_committed",
        tenantId: params.tenant_id,
        bindingId: params.binding_id,
        messageId: lastAckedMessageId,
      });
    }
  }

  async function runDiscordInboundPollPass() {
    const bindings = deps.db.stmtListActiveDiscordBindings.all() as ActiveDiscordBindingRow[];
    for (const binding of bindings) {
      const route = parseDiscordRouteKey(binding.route_key);
      if (
        deps.getDiscordGatewayReady() &&
        deps.config.discordGatewayDmEnabled &&
        route?.kind === "dm"
      ) {
        continue;
      }
      if (
        deps.getDiscordGatewayReady() &&
        deps.config.discordGatewayGuildEnabled &&
        route?.kind === "guild"
      ) {
        continue;
      }
      try {
        await forwardDiscordBindingInbound(binding);
      } catch (error) {
        const err = error instanceof Error ? error : undefined;
        deps.log({
          type: "discord_inbound_forward_error",
          tenantId: binding.tenant_id,
          bindingId: binding.binding_id,
          error: String(error),
          message: err?.message,
          cause: err?.cause instanceof Error ? err.cause.message : undefined,
          stack: err?.stack,
        });
      }
    }
  }

  async function runDiscordInboundLoop() {
    if (!deps.config.discordInboundEnabled) {
      return;
    }
    deps.discordBgRetryCount.clear();
    deps.discordBgRetryQueuedAtMs.clear();
    deps.discordRuntimeHealth.pollLoopStartedAtMs = Date.now();
    let running = true;
    process.on("SIGINT", () => {
      running = false;
    });
    process.on("SIGTERM", () => {
      running = false;
    });

    const pollMs = Math.max(200, Math.trunc(deps.config.discordPollIntervalMs));
    while (running) {
      try {
        await runDiscordInboundPollPass();
        deps.discordRuntimeHealth.lastPollSuccessAtMs = Date.now();
        deps.discordRuntimeHealth.lastPollErrorAtMs = null;
        deps.discordRuntimeHealth.lastPollError = null;
      } catch (error) {
        deps.discordRuntimeHealth.lastPollErrorAtMs = Date.now();
        deps.discordRuntimeHealth.lastPollError = errorString(error);
        const err = error instanceof Error ? error : undefined;
        deps.log({
          type: "discord_inbound_poll_error",
          error: String(error),
          message: err?.message,
          cause: err?.cause instanceof Error ? err.cause.message : undefined,
          stack: err?.stack,
        });
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
    }
  }

  async function handleDiscordGatewayMessage(message: Record<string, unknown>) {
    const messageId = readUnsignedNumericString(message.id);
    const author = asRecord(message.author);
    const fromId = readUnsignedNumericString(author?.id);
    const isBot = author?.bot === true;
    if (!messageId || !fromId || isBot) {
      return;
    }

    const incoming = await deps.resolveDiscordIncomingRouteFromMessage({
      message,
      fromId,
    });
    if (!incoming) {
      return;
    }
    const route = incoming.route;
    const channelId = incoming.channelId;
    if (route.kind === "dm" && !deps.config.discordGatewayDmEnabled) {
      return;
    }
    if (route.kind === "guild" && !deps.config.discordGatewayGuildEnabled) {
      return;
    }

    const incomingRouteKey = buildDiscordRouteKey(route);
    const liveBinding = deps.resolveDiscordBindingForIncoming(route);
    const body = typeof message.content === "string" ? message.content : "";

    const botControlCommand = deps.parseBotControlCommand(body);
    if (botControlCommand) {
      try {
        if (!liveBinding) {
          await deps.handleDiscordBotControlCommandUnbound({
            command: botControlCommand,
            channelId,
            routeKey: incomingRouteKey,
            fromId,
          });
        } else {
          await deps.handleDiscordBotControlCommand({
            command: botControlCommand,
            channelId,
            routeKey: liveBinding.routeKey,
            fromId,
            tenantId: liveBinding.tenantId,
            bindingId: liveBinding.bindingId,
            status: liveBinding.status,
          });
        }
      } catch (error) {
        deps.log({
          type: "discord_bot_control_error",
          tenantId: liveBinding?.tenantId,
          bindingId: liveBinding?.bindingId,
          routeKey: liveBinding?.routeKey ?? incomingRouteKey,
          messageId,
          error: String(error),
        });
      }
      return;
    }

    const pairingToken = deps.extractPairingTokenFromDiscordMessage(message);
    if (!liveBinding || liveBinding.status === "pending") {
      if (!pairingToken) {
        const shouldSendUnpairedNotice =
          deps.isDiscordCommandText(body) ||
          (route.kind === "dm" && deps.hasDiscordMessageContent(message));
        if (shouldSendUnpairedNotice) {
          try {
            const notice = deps.renderUnpairedHintNotice("discord");
            await deps.sendDiscordPairingNotice({
              channelId,
              text: notice.text,
            });
          } catch (error) {
            deps.log({
              type: "discord_unpaired_command_notice_error",
              tenantId: liveBinding?.tenantId,
              bindingId: liveBinding?.bindingId,
              messageId,
              error: String(error),
            });
          }
        }
        return;
      }

      const tokenRow = deps.peekActivePairingToken(pairingToken);
      if (!tokenRow) {
        try {
          const notice = deps.renderPairingInvalidNotice("discord");
          await deps.sendDiscordPairingNotice({
            channelId,
            text: notice.text,
          });
        } catch (error) {
          deps.log({
            type: "discord_pairing_invalid_notice_error",
            tenantId: liveBinding?.tenantId,
            bindingId: liveBinding?.bindingId,
            messageId,
            error: String(error),
          });
        }
        deps.log({
          type: "discord_pairing_token_invalid",
          tenantId: liveBinding?.tenantId,
          bindingId: liveBinding?.bindingId,
          messageId,
          channelId,
        });
        return;
      }

      const claimed = deps.claimDiscordPairingToken({
        token: pairingToken,
        route,
        channelId,
      });
      if (!claimed) {
        try {
          const notice = deps.renderPairingInvalidNotice("discord");
          await deps.sendDiscordPairingNotice({
            channelId,
            text: notice.text,
          });
        } catch (error) {
          deps.log({
            type: "discord_pairing_notice_error",
            tenantId: liveBinding?.tenantId,
            bindingId: liveBinding?.bindingId,
            messageId,
            error: String(error),
          });
        }
        return;
      }

      await sendDiscordClaimNotices({
        claimed,
        channelId,
        fromId,
        route,
        messageId,
      });
      return;
    }

    if (pairingToken) {
      const reClaimed = deps.claimDiscordPairingToken({
        token: pairingToken,
        route,
        channelId,
      });
      if (reClaimed) {
        await sendDiscordClaimNotices({
          claimed: reClaimed,
          channelId,
          fromId,
          route,
          messageId,
        });
      } else {
        deps.log({
          type: "discord_pairing_token_ignored_bound_route",
          tenantId: liveBinding.tenantId,
          bindingId: liveBinding.bindingId,
          routeKey: liveBinding.routeKey,
          messageId,
        });
      }
      return;
    }

    const forwardParams = {
      tenantId: liveBinding.tenantId,
      bindingId: liveBinding.bindingId,
      routeKey: incomingRouteKey,
      route,
      channelId,
      message,
      messageId,
      fromId,
      body,
    };
    try {
      await deps.forwardDiscordMessageToTenant(forwardParams);
    } catch (error) {
      deps.log({
        type: "discord_inbound_forward_failed",
        tenantId: liveBinding.tenantId,
        messageId,
        error: errorString(error),
      });
      const tid = liveBinding.tenantId;
      const pending = deps.discordBgRetryCount.get(tid) ?? 0;
      if (pending < DISCORD_BG_RETRY_MAX_PER_TENANT) {
        deps.metrics.recordRetryScheduled("discord");
        if (pending <= 0) {
          deps.discordBgRetryQueuedAtMs.set(tid, Date.now());
        }
        deps.discordBgRetryCount.set(tid, pending + 1);
        void (async () => {
          try {
            for (let attempt = 1; attempt <= DISCORD_BG_RETRY_ATTEMPTS; attempt++) {
              await new Promise((r) => setTimeout(r, DISCORD_BG_RETRY_INTERVAL_MS * attempt));
              try {
                await deps.forwardDiscordMessageToTenant(forwardParams);
                deps.log({
                  type: "discord_inbound_bg_retry_ok",
                  messageId,
                  attempt,
                  tenantId: tid,
                });
                return;
              } catch {
                if (attempt === DISCORD_BG_RETRY_ATTEMPTS) {
                  deps.log({
                    type: "discord_inbound_bg_retry_exhausted",
                    messageId,
                    tenantId: tid,
                  });
                }
              }
            }
          } finally {
            const nextPending = (deps.discordBgRetryCount.get(tid) ?? 1) - 1;
            if (nextPending <= 0) {
              deps.discordBgRetryCount.delete(tid);
              deps.discordBgRetryQueuedAtMs.delete(tid);
            } else {
              deps.discordBgRetryCount.set(tid, nextPending);
            }
          }
        })();
      } else {
        deps.log({
          type: "discord_inbound_bg_retry_skipped_cap",
          messageId,
          tenantId: tid,
          pending,
        });
      }
    }
  }

  async function runDiscordGatewayDmSession(): Promise<void> {
    const gatewayUrl = await deps.fetchDiscordGatewayUrl();
    const token = deps.requireDiscordBotToken();
    deps.setDiscordGatewayReady(false);
    deps.discordRuntimeHealth.gatewayLastError = null;
    deps.discordRuntimeHealth.gatewayLastErrorAtMs = null;
    const intents =
      Number.isFinite(deps.config.discordGatewayIntents) && deps.config.discordGatewayIntents > 0
        ? Math.trunc(deps.config.discordGatewayIntents)
        : deps.config.discordGatewayDefaultIntents;

    await new Promise<void>((resolve) => {
      let seq: number | null = null;
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let settled = false;
      const ws = new WebSocket(gatewayUrl);

      const clearHeartbeat = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        deps.setDiscordGatewayReady(false);
        clearHeartbeat();
        resolve();
      };
      const sendHeartbeat = () => {
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        try {
          ws.send(JSON.stringify({ op: 1, d: seq }));
        } catch (error) {
          deps.log({
            type: "discord_gateway_dm_heartbeat_error",
            error: String(error),
          });
        }
      };

      ws.on("open", () => {
        deps.log({
          type: "discord_gateway_dm_open",
          intents,
        });
      });

      ws.on("message", (raw) => {
        const frame = deps.parseDiscordGatewayPayload(raw);
        if (!frame) {
          return;
        }

        const op = Number(frame.op);
        if (Number.isFinite(Number(frame.s))) {
          seq = Math.trunc(Number(frame.s));
        }

        if (op === 10) {
          const hello = asRecord(frame.d);
          const heartbeatIntervalMs = readPositiveInt(hello?.heartbeat_interval) ?? 45_000;
          clearHeartbeat();
          heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);
          sendHeartbeat();
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                token,
                intents,
                properties: {
                  os: process.platform,
                  browser: "openclaw-mux",
                  device: "openclaw-mux",
                },
              },
            }),
          );
          return;
        }

        if (op === 1) {
          sendHeartbeat();
          return;
        }

        if (op === 7 || op === 9) {
          ws.close(4_000, op === 7 ? "gateway_reconnect" : "gateway_invalid_session");
          return;
        }

        if (op !== 0) {
          return;
        }

        const eventType = typeof frame.t === "string" ? frame.t : "";
        if (eventType === "READY") {
          const ready = asRecord(frame.d);
          deps.setDiscordGatewayReady(true);
          deps.discordRuntimeHealth.gatewayReadyAtMs = Date.now();
          const readyUser = asRecord(ready?.user);
          const selfId = readNonEmptyString(readyUser?.id);
          if (selfId) {
            deps.setDiscordBotSelfId(selfId);
          }
          deps.log({
            type: "discord_gateway_dm_ready",
            sessionId: readNonEmptyString(ready?.session_id) ?? null,
            botSelfId: deps.getDiscordBotSelfId(),
          });
          return;
        }
        if (eventType !== "MESSAGE_CREATE") {
          return;
        }

        const eventData = asRecord(frame.d);
        if (!eventData) {
          return;
        }
        deps.discordRuntimeHealth.lastInboundSeenAtMs = Date.now();
        void handleDiscordGatewayMessage(eventData).catch((error) => {
          deps.log({
            type: "discord_gateway_dm_event_error",
            error: String(error),
          });
        });
      });

      ws.on("error", (error) => {
        deps.discordRuntimeHealth.gatewayLastErrorAtMs = Date.now();
        deps.discordRuntimeHealth.gatewayLastError = errorString(error);
        deps.log({
          type: "discord_gateway_dm_socket_error",
          error: String(error),
        });
      });

      ws.on("close", (code, reason) => {
        deps.discordRuntimeHealth.gatewayLastCloseAtMs = Date.now();
        deps.log({
          type: "discord_gateway_dm_close",
          code,
          reason: reason.toString(),
        });
        finish();
      });
    });
  }

  async function runDiscordGatewayDmLoop() {
    if (
      !deps.config.discordInboundEnabled ||
      (!deps.config.discordGatewayDmEnabled && !deps.config.discordGatewayGuildEnabled)
    ) {
      return;
    }
    deps.discordRuntimeHealth.gatewayLoopStartedAtMs = Date.now();

    let running = true;
    process.on("SIGINT", () => {
      running = false;
    });
    process.on("SIGTERM", () => {
      running = false;
    });

    const reconnectInitial = Math.max(
      100,
      Math.trunc(deps.config.discordGatewayReconnectInitialMs),
    );
    const reconnectMax = Math.max(
      reconnectInitial,
      Math.trunc(deps.config.discordGatewayReconnectMaxMs),
    );
    let reconnectMs = reconnectInitial;

    while (running) {
      const startedAt = Date.now();
      try {
        await runDiscordGatewayDmSession();
      } catch (error) {
        deps.discordRuntimeHealth.gatewayLastErrorAtMs = Date.now();
        deps.discordRuntimeHealth.gatewayLastError = errorString(error);
        deps.log({
          type: "discord_gateway_dm_loop_error",
          error: String(error),
        });
      }
      if (!running) {
        break;
      }

      const lifetimeMs = Date.now() - startedAt;
      reconnectMs =
        lifetimeMs >= 60_000 ? reconnectInitial : Math.min(reconnectMs * 2, reconnectMax);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, reconnectMs));
    }
  }

  return {
    runDiscordInboundLoop,
    runDiscordGatewayDmLoop,
  };
}
