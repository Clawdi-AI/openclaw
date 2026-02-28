import { OBS_ERROR_CODES, type ObservabilityErrorCode } from "./error-codes.js";

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function inferErrorCodeFromLogEvent(
  event: Record<string, unknown>,
): ObservabilityErrorCode | undefined {
  const existing = readString(event.errorCode);
  if (existing && Object.values(OBS_ERROR_CODES).includes(existing as ObservabilityErrorCode)) {
    return existing as ObservabilityErrorCode;
  }

  const type = readString(event.type) ?? "";
  const errorText = readString(event.error) ?? "";

  if (type === "auth_unauthorized") {
    return OBS_ERROR_CODES.AUTH_UNAUTHORIZED;
  }
  if (type.endsWith("_pairing_token_invalid")) {
    return OBS_ERROR_CODES.PAIRING_TOKEN_INVALID;
  }
  if (type.endsWith("_inbound_drop_no_target")) {
    return OBS_ERROR_CODES.ROUTE_NOT_BOUND;
  }
  if (
    type.endsWith("_inbound_retry_deferred") ||
    type.endsWith("_inbound_forward_failed") ||
    type === "discord_inbound_forward_error"
  ) {
    return OBS_ERROR_CODES.INBOUND_FORWARD_FAILED;
  }
  if (type.endsWith("_inbound_bg_retry_exhausted")) {
    return OBS_ERROR_CODES.QUEUE_RETRY_EXHAUSTED;
  }
  if (type === "telegram_inbound_poll_error" && /\b409\b/.test(errorText)) {
    return OBS_ERROR_CODES.CHANNEL_POLL_CONFLICT;
  }
  if (type === "relay_error" || /send failed/i.test(errorText)) {
    return OBS_ERROR_CODES.OUTBOUND_PROVIDER_FAILED;
  }
  return undefined;
}
