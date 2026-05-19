import { describe, expect, it } from "vitest";
import { resolveWaWebSocketUrl } from "./wa-websocket-url.js";

describe("resolveWaWebSocketUrl", () => {
  it("returns undefined when nothing is configured", () => {
    expect(resolveWaWebSocketUrl({ env: {} })).toBeUndefined();
  });

  it("prefers per-account wsUrl over env var", () => {
    expect(
      resolveWaWebSocketUrl({
        accountWsUrl: "wss://msg-router.example/whatsapp",
        env: { WA_WEBSOCKET_URL: "wss://other.example/whatsapp" },
      }),
    ).toBe("wss://msg-router.example/whatsapp");
  });

  it("falls back to env var when account.wsUrl is unset", () => {
    expect(
      resolveWaWebSocketUrl({
        env: { WA_WEBSOCKET_URL: "wss://env.example/whatsapp" },
      }),
    ).toBe("wss://env.example/whatsapp");
  });

  it("treats whitespace-only values as unset", () => {
    expect(
      resolveWaWebSocketUrl({
        accountWsUrl: "   ",
        env: { WA_WEBSOCKET_URL: "  " },
      }),
    ).toBeUndefined();
  });

  it("trims surrounding whitespace on the resolved value", () => {
    expect(resolveWaWebSocketUrl({ accountWsUrl: "  wss://x.example/  " })).toBe(
      "wss://x.example/",
    );
  });

  it("non-string env values resolve to undefined", () => {
    expect(
      resolveWaWebSocketUrl({
        env: { WA_WEBSOCKET_URL: undefined as unknown as string },
      }),
    ).toBeUndefined();
  });
});
