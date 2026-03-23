export class WhatsAppInboundDeliveryError extends Error {
  retryable: boolean;
  statusCode: number | null;
  targetUpdatedAtMs: number | null;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      statusCode?: number | null;
      targetUpdatedAtMs?: number | null;
      cause?: unknown;
    },
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "WhatsAppInboundDeliveryError";
    this.retryable = options.retryable;
    this.statusCode =
      typeof options.statusCode === "number" && Number.isFinite(options.statusCode)
        ? Math.trunc(options.statusCode)
        : null;
    this.targetUpdatedAtMs =
      typeof options.targetUpdatedAtMs === "number" && Number.isFinite(options.targetUpdatedAtMs)
        ? Math.trunc(options.targetUpdatedAtMs)
        : null;
  }
}

export type WhatsAppInboundDeliveryFailure = {
  retryable: boolean;
  statusCode: number | null;
  targetUpdatedAtMs: number | null;
  errorMessage: string;
};

type WhatsAppInboundQueueRetryRow = {
  attempt_count: number;
  created_at_ms: number;
  delivery_window_started_at_ms: number;
  last_target_update_at_ms: number;
};

export function isRetryableWhatsAppInboundStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

export function classifyWhatsAppInboundDeliveryError(
  error: unknown,
  formatError: (error: unknown) => string,
): WhatsAppInboundDeliveryFailure {
  if (error instanceof WhatsAppInboundDeliveryError) {
    return {
      retryable: error.retryable,
      statusCode: error.statusCode,
      targetUpdatedAtMs: error.targetUpdatedAtMs,
      errorMessage: formatError(error),
    };
  }
  return {
    retryable: true,
    statusCode: null,
    targetUpdatedAtMs: null,
    errorMessage: formatError(error),
  };
}

function readPositiveInt(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

export function resolveWhatsAppInboundQueueRetryState(input: {
  row: WhatsAppInboundQueueRetryRow;
  now: number;
  maxAgeMs: number;
  failure: WhatsAppInboundDeliveryFailure;
}): {
  attemptCount: number;
  deliveryWindowStartedAtMs: number;
  lastTargetUpdateAtMs: number;
  ageMs: number;
  exhausted: boolean;
} {
  const { row, now, maxAgeMs, failure } = input;
  const attemptCount = (readPositiveInt(row.attempt_count) ?? 0) + 1;
  const createdAtMs = readPositiveInt(row.created_at_ms) ?? now;
  let deliveryWindowStartedAtMs = readPositiveInt(row.delivery_window_started_at_ms) ?? createdAtMs;
  let lastTargetUpdateAtMs = readPositiveInt(row.last_target_update_at_ms) ?? 0;
  const targetUpdatedAtMs = readPositiveInt(failure.targetUpdatedAtMs) ?? 0;
  if (targetUpdatedAtMs > lastTargetUpdateAtMs) {
    deliveryWindowStartedAtMs = now;
    lastTargetUpdateAtMs = targetUpdatedAtMs;
  }
  const ageMs = Math.max(0, now - deliveryWindowStartedAtMs);
  return {
    attemptCount,
    deliveryWindowStartedAtMs,
    lastTargetUpdateAtMs,
    ageMs,
    exhausted: !failure.retryable || ageMs >= Math.max(1_000, Math.trunc(maxAgeMs)),
  };
}
