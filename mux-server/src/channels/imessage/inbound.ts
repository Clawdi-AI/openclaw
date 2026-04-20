import type { MuxConfig } from "../../config/env.js";
import type { PreparedStatements } from "../../db/statements.js";
import type { ClaimResult, StyledNotice, TenantInboundTarget } from "../../domain/types.js";
import { asRecord, errorString, readNonEmptyString } from "../../domain/values.js";
import { buildIMessageInboundEnvelope, type MuxInboundAttachment } from "../../mux-envelope.js";
import { createInboundTraceId } from "../../observability/tracing.js";
import { buildIMessageRouteKey, deriveIMessageSessionKey } from "../../routing/keys.js";
import type { IMessageSdkInstance, createIMessageApiService } from "./api.js";

type IMessageApiService = ReturnType<typeof createIMessageApiService>;

type Metrics = {
  recordInboundEvent: (
    channel: "imessage",
    outcome: "forwarded" | "dropped" | "deferred" | "error",
  ) => void;
  observeInboundForwardDuration: (channel: "imessage", durationMs: number) => void;
  recordActiveUser: (channel: "imessage", userId: string) => void;
};

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

// Bounded in-memory retry buffer — best-effort recovery for transient forward
// failures. When the remote tenant target is briefly unavailable (5xx, network
// blip) we requeue the envelope with exponential backoff instead of dropping
// silently. The queue is bounded to cap memory under sustained outages.
const MAX_INBOUND_RETRY_ATTEMPTS = 3;
const INBOUND_RETRY_QUEUE_CAP = 256;
const INBOUND_RETRY_BASE_DELAY_MS = 2_000;

// Module-level shutdown flag + signal handlers.
//
// Why module-level (different from telegram/discord/whatsapp loops):
//   The SDK is driven by an EventEmitter, so `start()` never loops per tick —
//   it awaits a session-end promise per connection. Re-registering handlers
//   inside start() would leak a SIGINT listener every reconnect. Telegram's
//   loop exits its while-loop on shutdown and gets re-entered only on process
//   restart, so per-call registration is safe there. iMessage start() is
//   idempotent per process, so a single module-level registration is correct.
let running = true;
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});

export function createIMessageInboundRuntime(deps: {
  config: Pick<MuxConfig, "imessageInboundEnabled" | "imessageServerUrl" | "openclawMuxAccountId">;
  apiService: IMessageApiService;
  metrics: Metrics;
  log: (entry: Record<string, unknown>) => void;
  db: Pick<PreparedStatements, "stmtSelectSessionKeyByBinding" | "stmtUpsertSessionRoute">;
  selectActiveBindingByRouteKey: (
    channel: "imessage",
    routeKey: string,
  ) => { tenantId: string; bindingId: string; routeKey: string } | null;
  resolveTenantInboundTarget: (tenantId: string) => TenantInboundTarget | null;
  buildInboundAuthHeaders: (
    target: TenantInboundTarget,
    traceId?: string,
  ) => Promise<Record<string, string>>;
  claimIMessagePairingToken: (params: {
    token: string;
    chatGuid: string;
    chatType: "direct" | "group";
  }) => ClaimResult | null;
  renderUnpairedHintNotice: (channel: "imessage") => StyledNotice;
  sendPostClaimNotices: (params: {
    channel: "imessage";
    claimed: ClaimResult;
    send: (notice: StyledNotice) => Promise<void>;
    fromId: string;
    chatId: string;
    chatType: "direct" | "group";
  }) => Promise<void>;
}) {
  function isPairingTokenCandidate(body: string): boolean {
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > 64) {
      return false;
    }
    return !trimmed.includes(" ") && !trimmed.includes("\n");
  }

  async function extractInboundAttachments(
    message: Record<string, unknown>,
    activeSdk: IMessageSdkInstance,
  ): Promise<MuxInboundAttachment[]> {
    const media: MuxInboundAttachment[] = [];
    if (!Array.isArray(message.attachments)) {
      return media;
    }
    for (const entry of message.attachments) {
      const attachment = asRecord(entry);
      if (!attachment) {
        continue;
      }
      const mimeType = readNonEmptyString(attachment.mimeType) ?? undefined;
      const fileName = readNonEmptyString(attachment.transferName) ?? undefined;
      const guid = readNonEmptyString(attachment.guid);
      let content: string | undefined;
      if (guid) {
        // Use the caller-captured SDK reference so a concurrent reconnect
        // (which nulls the service-level sdk) does not silently return null.
        const buffer = await deps.apiService.downloadAttachmentWith(activeSdk, guid);
        if (buffer) {
          if (buffer.length > MAX_ATTACHMENT_BYTES) {
            deps.log({ type: "imessage_attachment_too_large", guid, bytes: buffer.length });
          } else if (buffer.length > 0) {
            content = buffer.toString("base64");
          }
        }
      }
      const type = mimeType?.startsWith("image/") ? "image" : "file";
      media.push({
        type,
        ...(mimeType ? { mimeType } : {}),
        ...(fileName ? { fileName } : {}),
        ...(content ? { content } : {}),
      });
    }
    return media;
  }

  type ForwardParams = {
    tenantId: string;
    bindingId: string;
    routeKey: string;
    chatGuid: string;
    messageId: string;
    from: string;
    body: string;
    chatType: "direct" | "group";
    timestampMs: number;
    media: MuxInboundAttachment[];
  };

  type RetryEntry = {
    params: ForwardParams;
    attempt: number;
    nextAttemptAtMs: number;
  };

  // Bounded FIFO of in-flight retries keyed by messageId to avoid unbounded
  // memory growth during sustained outages. When full, the oldest entry is
  // evicted and counted as a drop — we surface this explicitly rather than
  // silently swallow.
  const retryQueue = new Map<string, RetryEntry>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRetryPump(): void {
    if (retryTimer || retryQueue.size === 0) {
      return;
    }
    let nextAt = Number.POSITIVE_INFINITY;
    for (const entry of retryQueue.values()) {
      if (entry.nextAttemptAtMs < nextAt) {
        nextAt = entry.nextAttemptAtMs;
      }
    }
    const delay = Math.max(0, nextAt - Date.now());
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void pumpRetryQueue();
    }, delay);
    // Do not keep the process alive solely for retries.
    if (typeof retryTimer === "object" && retryTimer && "unref" in retryTimer) {
      (retryTimer as { unref: () => void }).unref();
    }
  }

  async function pumpRetryQueue(): Promise<void> {
    if (!running) {
      return;
    }
    const now = Date.now();
    const due: RetryEntry[] = [];
    for (const [key, entry] of retryQueue) {
      if (entry.nextAttemptAtMs <= now) {
        retryQueue.delete(key);
        due.push(entry);
      }
    }
    for (const entry of due) {
      const status = await forwardToTenant(entry.params);
      if (status === "forwarded") {
        continue;
      }
      if (entry.attempt >= MAX_INBOUND_RETRY_ATTEMPTS) {
        deps.metrics.recordInboundEvent("imessage", "dropped");
        deps.log({
          type: "imessage_inbound_retry_exhausted",
          tenantId: entry.params.tenantId,
          bindingId: entry.params.bindingId,
          messageId: entry.params.messageId,
          attempts: entry.attempt,
          finalStatus: status,
        });
        continue;
      }
      enqueueRetry(entry.params, entry.attempt + 1);
    }
    scheduleRetryPump();
  }

  function enqueueRetry(params: ForwardParams, attempt: number): void {
    if (retryQueue.size >= INBOUND_RETRY_QUEUE_CAP) {
      // Evict oldest (insertion-ordered Map) to make room.
      const oldestKey = retryQueue.keys().next().value;
      if (oldestKey !== undefined) {
        const evicted = retryQueue.get(oldestKey);
        retryQueue.delete(oldestKey);
        if (evicted) {
          deps.metrics.recordInboundEvent("imessage", "dropped");
          deps.log({
            type: "imessage_inbound_retry_evicted_overflow",
            tenantId: evicted.params.tenantId,
            bindingId: evicted.params.bindingId,
            messageId: evicted.params.messageId,
            queueCap: INBOUND_RETRY_QUEUE_CAP,
          });
        }
      }
    }
    const delayMs = Math.min(30_000, INBOUND_RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 4));
    const nextAttemptAtMs = Date.now() + delayMs;
    retryQueue.set(params.messageId, { params, attempt, nextAttemptAtMs });
    deps.log({
      type: "imessage_inbound_retry_scheduled",
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      messageId: params.messageId,
      attempt,
      delayMs,
    });
    scheduleRetryPump();
  }

  async function forwardToTenant(
    params: ForwardParams,
  ): Promise<"forwarded" | "deferred" | "error"> {
    const target = deps.resolveTenantInboundTarget(params.tenantId);
    if (!target) {
      deps.log({
        type: "imessage_inbound_drop_no_target",
        tenantId: params.tenantId,
        bindingId: params.bindingId,
        routeKey: params.routeKey,
      });
      deps.metrics.recordInboundEvent("imessage", "deferred");
      return "deferred";
    }

    // Reuse the session key created during pairing if available; otherwise derive one.
    const existingRoute = deps.db.stmtSelectSessionKeyByBinding.get(
      params.tenantId,
      "imessage",
      params.bindingId,
    ) as { session_key?: unknown } | undefined;
    const existingSessionKey = readNonEmptyString(existingRoute?.session_key);
    const sessionKey =
      existingSessionKey ??
      deriveIMessageSessionKey({ chatGuid: params.chatGuid, chatType: params.chatType });

    deps.db.stmtUpsertSessionRoute.run(
      params.tenantId,
      "imessage",
      sessionKey,
      params.bindingId,
      JSON.stringify({ routeKey: params.routeKey, chatGuid: params.chatGuid }),
      Date.now(),
    );

    const traceId = createInboundTraceId({
      channel: "imessage",
      tenantId: params.tenantId,
      routeKey: params.routeKey,
      messageId: params.messageId,
    });

    const payload = buildIMessageInboundEnvelope({
      messageId: params.messageId,
      sessionKey,
      accountId: deps.config.openclawMuxAccountId,
      body: params.body,
      from: params.from,
      chatGuid: params.chatGuid,
      chatType: params.chatType,
      routeKey: params.routeKey,
      timestampMs: params.timestampMs,
      ...(params.media.length > 0 ? { media: params.media } : {}),
    });
    const payloadWithIdentity = { ...payload, openclawId: params.tenantId };

    const forwardStartedAtMs = Date.now();
    let response: Response;
    try {
      response = await fetch(target.url, {
        method: "POST",
        headers: {
          ...(await deps.buildInboundAuthHeaders(target, traceId)),
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payloadWithIdentity),
        signal: AbortSignal.timeout(target.timeoutMs),
      });
    } catch (error) {
      deps.metrics.observeInboundForwardDuration("imessage", Date.now() - forwardStartedAtMs);
      deps.metrics.recordInboundEvent("imessage", "error");
      deps.log({
        type: "imessage_inbound_forward_network_error",
        tenantId: params.tenantId,
        bindingId: params.bindingId,
        messageId: params.messageId,
        error: errorString(error),
        traceId,
      });
      return "deferred";
    }

    if (!response.ok) {
      deps.metrics.observeInboundForwardDuration("imessage", Date.now() - forwardStartedAtMs);
      deps.metrics.recordInboundEvent("imessage", "error");
      const bodyText = await response.text();
      deps.log({
        type: "imessage_inbound_forward_failed",
        tenantId: params.tenantId,
        bindingId: params.bindingId,
        messageId: params.messageId,
        status: response.status,
        body: bodyText.slice(0, 200),
        traceId,
      });
      return "error";
    }

    deps.metrics.observeInboundForwardDuration("imessage", Date.now() - forwardStartedAtMs);
    deps.metrics.recordInboundEvent("imessage", "forwarded");
    deps.log({
      type: "imessage_inbound_forwarded",
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      chatGuid: params.chatGuid,
      sessionKey,
      messageId: params.messageId,
      traceId,
    });
    return "forwarded";
  }

  // TODO(imessage-bot-control): iMessage does not yet support slash-style
  // bot-control commands (/bot_status, /bot_unpair, /bot_switch) that
  // Telegram/Discord expose. Users interact via plain text. This is a feature
  // gap, not a regression — tracked separately from mux transport plumbing.
  async function handleInboundMessage(
    message: Record<string, unknown>,
    activeSdk: IMessageSdkInstance | null,
  ): Promise<void> {
    if (message.isFromMe) {
      return;
    }
    const chats = Array.isArray(message.chats) ? message.chats : [];
    const chat = asRecord(chats[0]);
    if (!chat) {
      return;
    }
    const chatGuid = readNonEmptyString(chat.guid);
    if (!chatGuid) {
      return;
    }
    const messageId = readNonEmptyString(message.guid);
    if (!messageId) {
      return;
    }
    const handle = asRecord(message.handle);
    const from = readNonEmptyString(handle?.address) ?? "";
    const body = typeof message.text === "string" ? message.text : "";
    const isGroup = chatGuid.includes(";+;");
    const chatType: "direct" | "group" = isGroup ? "group" : "direct";
    const routeKey = buildIMessageRouteKey({ chatGuid, chatType });
    const timestampMs =
      typeof message.dateCreated === "number" && Number.isFinite(message.dateCreated)
        ? Math.trunc(message.dateCreated)
        : Date.now();

    deps.apiService.markInboundSeen();
    const media = activeSdk ? await extractInboundAttachments(message, activeSdk) : [];

    deps.log({
      type: "imessage_inbound_received",
      chatGuid,
      from,
      messageId,
      chatType,
      hasMedia: media.length > 0,
    });

    // 1. Try pairing-token claim when body looks token-shaped.
    if (isPairingTokenCandidate(body)) {
      const token = body.trim();
      const claimed = deps.claimIMessagePairingToken({
        token,
        chatGuid,
        chatType,
      });
      if (claimed) {
        try {
          await deps.sendPostClaimNotices({
            channel: "imessage",
            claimed,
            send: async (notice) => {
              await deps.apiService.sendPairingNotice({ chatGuid, text: notice.text });
            },
            fromId: from || chatGuid,
            chatId: chatGuid,
            chatType,
          });
        } catch (error) {
          deps.log({
            type: "imessage_pairing_notice_error",
            tenantId: claimed.tenantId,
            chatGuid,
            messageId,
            phase: "post_claim",
            error: errorString(error),
          });
        }
        // After the text pairing notice lands, send the Clawdi vCard so the
        // user's Messages app offers "Add to Contacts" in-thread — avoids
        // a forever-anonymous "+1415…" header bar. Best-effort: failures
        // are logged inside sendPairingContact, not rethrown here.
        await deps.apiService.sendPairingContact({ chatGuid });
        deps.log({
          type: "imessage_pairing_token_claimed",
          tenantId: claimed.tenantId,
          routeKey: claimed.routeKey,
          sessionKey: claimed.sessionKey,
          claimType: claimed.claimType,
          ...(claimed.previousTenantId ? { previousTenantId: claimed.previousTenantId } : {}),
          chatGuid,
        });
        return;
      }
      // Token format matches but no active pairing token found — fall through to routing
      // so short messages like "Hello" are not silently dropped.
    }

    // 2. Route to bound tenant.
    const binding = deps.selectActiveBindingByRouteKey("imessage", routeKey);
    if (!binding) {
      // DM from unpaired user: send a hint. Group messages are not nudged.
      if (!isGroup) {
        try {
          const notice = deps.renderUnpairedHintNotice("imessage");
          await deps.apiService.sendPairingNotice({ chatGuid, text: notice.text });
        } catch (error) {
          deps.log({
            type: "imessage_unpaired_notice_error",
            chatGuid,
            messageId,
            phase: "unpaired_hint",
            error: errorString(error),
          });
        }
      }
      deps.log({ type: "imessage_inbound_no_binding", chatGuid, routeKey });
      return;
    }

    deps.metrics.recordActiveUser("imessage", from || chatGuid);
    const fromId = from || chatGuid;
    const forwardParams: ForwardParams = {
      tenantId: binding.tenantId,
      bindingId: binding.bindingId,
      routeKey: binding.routeKey,
      chatGuid,
      messageId,
      from: fromId,
      body,
      chatType,
      timestampMs,
      media,
    };
    const status = await forwardToTenant(forwardParams);
    if (status === "forwarded") {
      return;
    }
    // Explicit non-silent handling of transient failures. The new-message event
    // is consumed only once by the SDK, so without this buffer a target that is
    // temporarily unavailable would cause permanent message loss.
    deps.log({
      type: "imessage_inbound_deferred_no_retry",
      tenantId: binding.tenantId,
      bindingId: binding.bindingId,
      routeKey: binding.routeKey,
      messageId,
      status,
    });
    enqueueRetry(forwardParams, 1);
  }

  async function start(): Promise<void> {
    if (!deps.config.imessageInboundEnabled || !deps.config.imessageServerUrl) {
      return;
    }

    const health = deps.apiService.getHealth();
    health.loopStartedAtMs = Date.now();

    let attempt = 0;
    while (running) {
      attempt += 1;

      // Connect SDK
      try {
        const sdkInstance = await deps.apiService.createSdk();
        deps.apiService.setSdk(sdkInstance);
        await sdkInstance.connect();
        deps.apiService.markConnected();
        attempt = 0;
        deps.log({ type: "imessage_sdk_connected", serverUrl: deps.config.imessageServerUrl });
      } catch (error) {
        deps.apiService.setSdk(null);
        deps.apiService.markError(error);
        deps.log({
          type: "imessage_sdk_connect_failed",
          error: String(error),
          attempt,
        });
        const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // Capture SDK reference in a local const so async handlers don't race on
      // module-level mutation during reconnects.
      const currentSdk = deps.apiService.getSdk();
      if (!currentSdk) {
        continue;
      }

      // Session ends on disconnect OR error so the loop never hangs.
      let resolveSession: () => void = () => {};
      const sessionEndPromise = new Promise<void>((resolve) => {
        resolveSession = resolve;
      });

      currentSdk.on("disconnect", () => {
        deps.apiService.markDisconnected();
        deps.log({ type: "imessage_sdk_disconnected" });
        resolveSession();
      });

      currentSdk.on("error", (error: unknown) => {
        deps.apiService.markError(error);
        deps.log({ type: "imessage_sdk_error", error: String(error) });
        resolveSession();
      });

      currentSdk.on("ready", () => {
        deps.apiService.markConnected();
        deps.log({ type: "imessage_sdk_ready" });
      });

      currentSdk.on("new-message", (message: unknown) => {
        // Capture the SDK reference synchronously, BEFORE any await, so that a
        // concurrent reconnect (which calls setSdk(null)) cannot invalidate
        // downstream attachment downloads mid-flight. `currentSdk` is the
        // per-session constant from the enclosing scope — attachment downloads
        // are routed through this reference, not the mutable service-level sdk.
        const capturedSdk = currentSdk;
        void (async () => {
          try {
            const record = asRecord(message);
            if (!record) {
              return;
            }
            await handleInboundMessage(record, capturedSdk);
          } catch (error) {
            deps.log({ type: "imessage_inbound_processing_error", error: String(error) });
          }
        })();
      });

      // Wait for disconnect or fatal error, then clean up and reconnect.
      await sessionEndPromise;
      try {
        await currentSdk.close();
      } catch (closeErr) {
        deps.log({ type: "imessage_sdk_close_error", error: String(closeErr) });
      }
      deps.apiService.setSdk(null);

      if (!running) {
        break;
      }
      const retryDelayMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      deps.log({ type: "imessage_reconnecting", delayMs: retryDelayMs });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  async function stop(): Promise<void> {
    running = false;
    const current = deps.apiService.getSdk();
    if (!current) {
      return;
    }
    try {
      await current.close();
    } catch (error) {
      deps.log({ type: "imessage_sdk_close_error", error: String(error) });
    }
  }

  return {
    start,
    stop,
    getHealth: deps.apiService.getHealth,
  };
}
