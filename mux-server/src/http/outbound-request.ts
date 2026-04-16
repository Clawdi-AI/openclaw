import type { IncomingMessage, ServerResponse } from "node:http";
import type { TenantIdentity } from "../domain/types.js";
import { readOutboundOperation, type MuxPayload } from "../mux-envelope.js";
import type { SendResult } from "../outbound/service.js";

type InflightEntry = {
  fingerprint: string;
  promise: Promise<SendResult>;
};

type CachedIdempotencyRow = {
  request_fingerprint: string;
  response_status: number;
  response_body: string;
};

export function createOutboundRequestHandler(deps: {
  idempotencyTtlMs: number;
  idempotencyInflight: Map<string, InflightEntry>;
  stmtDeleteExpiredIdempotency: {
    run: (now: number) => void;
  };
  stmtSelectCachedIdempotency: {
    get: (
      tenantId: string,
      idempotencyKey: string,
      now: number,
    ) => CachedIdempotencyRow | undefined;
  };
  stmtUpsertIdempotency: {
    run: (
      tenantId: string,
      idempotencyKey: string,
      fingerprint: string,
      statusCode: number,
      bodyText: string,
      expiresAtMs: number,
      createdAtMs: number,
    ) => void;
  };
  readBody: <T extends object>(req: IncomingMessage) => Promise<T>;
  sendJson: (res: ServerResponse, statusCode: number, payload: unknown) => string;
  normalizeChannel: (value: unknown) => string | null;
  metrics: {
    recordOutboundRequest: (params: {
      channel: string | null;
      method: string;
      statusCode: number;
      durationMs: number;
    }) => void;
  };
  log: (entry: Record<string, unknown>) => void;
  runOutboundSend: (params: { tenant: TenantIdentity; payload: MuxPayload }) => Promise<SendResult>;
}): {
  handleOutboundSendRequest: (params: {
    req: IncomingMessage;
    res: ServerResponse;
    tenant: TenantIdentity;
  }) => Promise<void>;
} {
  function resolveInflightKey(tenantId: string, idempotencyKey: string): string {
    return `${tenantId}:${idempotencyKey}`;
  }

  function purgeExpiredIdempotency(now: number) {
    deps.stmtDeleteExpiredIdempotency.run(now);
  }

  function loadCachedIdempotency(params: {
    tenantId: string;
    idempotencyKey: string;
    fingerprint: string;
    now: number;
  }): SendResult | "mismatch" | null {
    const row = deps.stmtSelectCachedIdempotency.get(
      params.tenantId,
      params.idempotencyKey,
      params.now,
    );
    if (!row) {
      return null;
    }
    if (row.request_fingerprint !== params.fingerprint) {
      return "mismatch";
    }
    return {
      statusCode: Number(row.response_status),
      bodyText: String(row.response_body),
    };
  }

  function storeIdempotency(params: {
    tenantId: string;
    idempotencyKey: string;
    fingerprint: string;
    result: SendResult;
    now: number;
  }) {
    deps.stmtUpsertIdempotency.run(
      params.tenantId,
      params.idempotencyKey,
      params.fingerprint,
      params.result.statusCode,
      params.result.bodyText,
      params.now + deps.idempotencyTtlMs,
      params.now,
    );
  }

  async function handleOutboundSendRequest(params: {
    req: IncomingMessage;
    res: ServerResponse;
    tenant: TenantIdentity;
  }): Promise<void> {
    const payload = await deps.readBody<MuxPayload>(params.req);
    const idempotencyKey =
      typeof params.req.headers["idempotency-key"] === "string"
        ? params.req.headers["idempotency-key"]
        : undefined;
    const fingerprint = JSON.stringify(payload);

    const now = Date.now();
    purgeExpiredIdempotency(now);
    if (idempotencyKey) {
      const cached = loadCachedIdempotency({
        tenantId: params.tenant.id,
        idempotencyKey,
        fingerprint,
        now,
      });
      if (cached === "mismatch") {
        deps.sendJson(params.res, 409, {
          ok: false,
          error: "idempotency key reused with different payload",
        });
        return;
      }
      if (cached) {
        deps.log({
          type: "idempotency_hit_cached",
          tenantId: params.tenant.id,
          idempotencyKey,
          status: cached.statusCode,
        });
        params.res.writeHead(cached.statusCode, {
          "content-type": "application/json; charset=utf-8",
        });
        params.res.end(cached.bodyText);
        return;
      }

      const inflightKey = resolveInflightKey(params.tenant.id, idempotencyKey);
      const inflight = deps.idempotencyInflight.get(inflightKey);
      if (inflight) {
        if (inflight.fingerprint !== fingerprint) {
          deps.sendJson(params.res, 409, {
            ok: false,
            error: "idempotency key reused with different payload",
          });
          return;
        }
        const result = await inflight.promise;
        deps.log({
          type: "idempotency_hit_inflight",
          tenantId: params.tenant.id,
          idempotencyKey,
          status: result.statusCode,
        });
        params.res.writeHead(result.statusCode, {
          "content-type": "application/json; charset=utf-8",
        });
        params.res.end(result.bodyText);
        return;
      }
    }

    const inflightKey = idempotencyKey
      ? resolveInflightKey(params.tenant.id, idempotencyKey)
      : undefined;
    const outboundChannel = deps.normalizeChannel(payload.channel);
    const outboundOperation = readOutboundOperation(payload);
    const outboundMethod =
      outboundOperation.op === "action"
        ? outboundOperation.action === "typing"
          ? "typing"
          : "action"
        : "send";
    const outboundStartedAtMs = Date.now();
    const inflightEntry: InflightEntry = {
      fingerprint,
      promise: deps.runOutboundSend({ tenant: params.tenant, payload }).then((result) => {
        deps.metrics.recordOutboundRequest({
          channel: outboundChannel,
          method: outboundMethod,
          statusCode: result.statusCode,
          durationMs: Date.now() - outboundStartedAtMs,
        });
        return result;
      }),
    };
    if (inflightKey) {
      deps.idempotencyInflight.set(inflightKey, inflightEntry);
    }

    const sendResult = await inflightEntry.promise;
    if (inflightKey && idempotencyKey) {
      deps.idempotencyInflight.delete(inflightKey);
      storeIdempotency({
        tenantId: params.tenant.id,
        idempotencyKey,
        fingerprint,
        result: sendResult,
        now: Date.now(),
      });
    }

    params.res.writeHead(sendResult.statusCode, {
      "content-type": "application/json; charset=utf-8",
    });
    params.res.end(sendResult.bodyText);
  }

  return {
    handleOutboundSendRequest,
  };
}
