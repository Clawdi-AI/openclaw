import { describe, expect, test } from "vitest";
import { createInboundTraceId, createTraceId } from "../src/observability/trace-id.js";

describe("observability trace-id", () => {
  test("returns stable trace id for identical parts", () => {
    const a = createTraceId(["telegram", 123, "abc"]);
    const b = createTraceId(["telegram", 123, "abc"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^mux_[a-f0-9]{20}$/);
  });

  test("changes when inputs change", () => {
    const a = createTraceId(["telegram", 123, "abc"]);
    const b = createTraceId(["telegram", 124, "abc"]);
    expect(a).not.toBe(b);
  });

  test("builds inbound trace ids with channel context", () => {
    const id = createInboundTraceId({
      channel: "telegram",
      tenantId: "tenant-a",
      routeKey: "telegram:default:chat:1",
      updateId: 100,
      messageId: "200",
    });
    expect(id).toMatch(/^mux_[a-f0-9]{20}$/);
  });
});
