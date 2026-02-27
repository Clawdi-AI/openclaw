import { describe, expect, test } from "vitest";
import { formatLogLine, normalizeLogEvent } from "../src/observability/log-event.js";

describe("observability log-event", () => {
  test("normalizes envelope fields", () => {
    const event = normalizeLogEvent(
      { type: "telegram_inbound_forwarded", foo: 1 },
      1_700_000_000_123,
    );
    expect(event).toMatchObject({
      type: "telegram_inbound_forwarded",
      foo: 1,
      component: "mux-server",
      level: "info",
      ts: 1_700_000_000_123,
    });
  });

  test("infers warn/error levels from event type", () => {
    const warnEvent = normalizeLogEvent(
      { type: "telegram_inbound_drop_no_target" },
      1_700_000_000_123,
    );
    expect(warnEvent.level).toBe("warn");

    const errorEvent = normalizeLogEvent({ type: "discord_inbound_poll_error" }, 1_700_000_000_123);
    expect(errorEvent.level).toBe("error");
  });

  test("formats log line with ISO prefix and JSON payload", () => {
    const line = formatLogLine({ type: "event", ts: 1_700_000_000_123, level: "info" });
    expect(line.startsWith("2023-")).toBe(true);
    expect(line).toContain('"type":"event"');
    expect(line.endsWith("\n")).toBe(true);
  });
});
