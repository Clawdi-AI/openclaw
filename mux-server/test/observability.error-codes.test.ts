import { describe, expect, test } from "vitest";
import { OBS_ERROR_CODES } from "../src/observability/error-codes.js";

describe("observability error-codes", () => {
  test("exports stable taxonomy keys", () => {
    expect(OBS_ERROR_CODES.AUTH_UNAUTHORIZED).toBe("AUTH_UNAUTHORIZED");
    expect(OBS_ERROR_CODES.ROUTE_NOT_BOUND).toBe("ROUTE_NOT_BOUND");
    expect(OBS_ERROR_CODES.PAIRING_TOKEN_INVALID).toBe("PAIRING_TOKEN_INVALID");
    expect(OBS_ERROR_CODES.INBOUND_FORWARD_FAILED).toBe("INBOUND_FORWARD_FAILED");
    expect(OBS_ERROR_CODES.OUTBOUND_PROVIDER_FAILED).toBe("OUTBOUND_PROVIDER_FAILED");
    expect(OBS_ERROR_CODES.QUEUE_RETRY_EXHAUSTED).toBe("QUEUE_RETRY_EXHAUSTED");
    expect(OBS_ERROR_CODES.CHANNEL_POLL_CONFLICT).toBe("CHANNEL_POLL_CONFLICT");
  });
});
