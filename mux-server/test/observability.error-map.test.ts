import { describe, expect, test } from "vitest";
import { OBS_ERROR_CODES } from "../src/observability/error-codes.js";
import { inferErrorCodeFromLogEvent } from "../src/observability/error-map.js";

describe("observability error-map", () => {
  test("maps common event types to normalized error codes", () => {
    expect(inferErrorCodeFromLogEvent({ type: "auth_unauthorized" })).toBe(
      OBS_ERROR_CODES.AUTH_UNAUTHORIZED,
    );
    expect(inferErrorCodeFromLogEvent({ type: "telegram_pairing_token_invalid" })).toBe(
      OBS_ERROR_CODES.PAIRING_TOKEN_INVALID,
    );
    expect(inferErrorCodeFromLogEvent({ type: "telegram_inbound_drop_no_target" })).toBe(
      OBS_ERROR_CODES.ROUTE_NOT_BOUND,
    );
    expect(inferErrorCodeFromLogEvent({ type: "discord_inbound_retry_deferred" })).toBe(
      OBS_ERROR_CODES.INBOUND_FORWARD_FAILED,
    );
    expect(inferErrorCodeFromLogEvent({ type: "telegram_inbound_bg_retry_exhausted" })).toBe(
      OBS_ERROR_CODES.QUEUE_RETRY_EXHAUSTED,
    );
    expect(
      inferErrorCodeFromLogEvent({
        type: "telegram_inbound_poll_error",
        error: "telegram getUpdates failed (409)",
      }),
    ).toBe(OBS_ERROR_CODES.CHANNEL_POLL_CONFLICT);
  });

  test("keeps explicit errorCode when present", () => {
    expect(
      inferErrorCodeFromLogEvent({
        type: "relay_error",
        errorCode: OBS_ERROR_CODES.AUTH_UNAUTHORIZED,
      }),
    ).toBe(OBS_ERROR_CODES.AUTH_UNAUTHORIZED);
  });
});
