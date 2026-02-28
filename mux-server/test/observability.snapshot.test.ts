import { describe, expect, test } from "vitest";
import { createObservabilitySnapshotStore } from "../src/observability/snapshot.js";

describe("observability snapshot", () => {
  test("builds bounded snapshot windows and recent errors", () => {
    const store = createObservabilitySnapshotStore({
      maxEvents: 10,
      maxRecentErrors: 5,
    });
    const now = Date.now();

    store.observe({
      ts: now - 30_000,
      type: "telegram_inbound_forwarded",
      level: "info",
      tenantId: "t1",
      channel: "telegram",
    });
    store.observe({
      ts: now - 20_000,
      type: "telegram_inbound_retry_deferred",
      level: "error",
      tenantId: "t1",
      channel: "telegram",
      error: "timeout",
    });
    store.observe({
      ts: now - 10_000,
      type: "auth_unauthorized",
      level: "warn",
      tenantId: "t2",
    });

    const snapshot = store.snapshot({
      nowMs: now,
      channels: {
        telegram: { status: "ready", ready: true },
        discord: { status: "disabled", ready: true },
        whatsapp: { status: "disabled", ready: true },
      },
      queueDepth: { telegram: 0, discord: 0, whatsapp: 0 },
      oldestQueuedAgeMs: { telegram: null, discord: null, whatsapp: null },
      tenantId: "t1",
      recentErrorsLimit: 2,
    });

    expect(snapshot.tenantId).toBe("t1");
    expect(snapshot.counters.last1m.telegram.events).toBe(2);
    expect(snapshot.counters.last1m.telegram.forwarded).toBe(1);
    expect(snapshot.counters.last1m.telegram.deferred).toBe(1);
    expect(snapshot.counters.last1m.telegram.errors).toBe(1);
    expect(snapshot.topErrorCodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INBOUND_FORWARD_FAILED", count: 1 }),
      ]),
    );
    expect(snapshot.recentErrors).toHaveLength(1);
    expect(snapshot.recentErrors[0]).toMatchObject({
      tenantId: "t1",
      type: "telegram_inbound_retry_deferred",
    });
  });
});
