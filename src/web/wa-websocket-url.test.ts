import { describe, expect, it } from "vitest";
import { resolveWaWebSocketUrl } from "./wa-websocket-url.js";

describe("wa websocket url", () => {
  it("returns undefined when env is unset", () => {
    expect(resolveWaWebSocketUrl({} as NodeJS.ProcessEnv)).toBe(undefined);
  });

  it("returns undefined for empty / whitespace env", () => {
    expect(resolveWaWebSocketUrl({ WA_WEBSOCKET_URL: "" } as NodeJS.ProcessEnv)).toBe(undefined);
    expect(resolveWaWebSocketUrl({ WA_WEBSOCKET_URL: "   " } as NodeJS.ProcessEnv)).toBe(undefined);
  });

  it("returns the env value when set", () => {
    expect(
      resolveWaWebSocketUrl({ WA_WEBSOCKET_URL: "ws://127.0.0.1:4000/" } as NodeJS.ProcessEnv),
    ).toBe("ws://127.0.0.1:4000");
  });

  it("strips trailing slashes", () => {
    expect(
      resolveWaWebSocketUrl({ WA_WEBSOCKET_URL: "wss://example.com/ws///" } as NodeJS.ProcessEnv),
    ).toBe("wss://example.com/ws");
  });
});
