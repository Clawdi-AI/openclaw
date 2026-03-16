import { describe, expect, it, vi } from "vitest";
import { resolveTelegramBotApiBaseUrl, resolveTelegramBotApiHostname } from "./api-base-url.js";

describe("telegram api base url", () => {
  it("defaults to api.telegram.org", () => {
    vi.unstubAllEnvs();
    expect(resolveTelegramBotApiBaseUrl()).toBe("https://api.telegram.org");
    expect(resolveTelegramBotApiHostname()).toBe("api.telegram.org");
  });

  it("uses TELEGRAM_BOT_API_BASE_URL without trailing slashes", () => {
    vi.stubEnv("TELEGRAM_BOT_API_BASE_URL", "https://tg.example.com/custom///");
    expect(resolveTelegramBotApiBaseUrl()).toBe("https://tg.example.com/custom");
    expect(resolveTelegramBotApiHostname()).toBe("tg.example.com");
  });
});
