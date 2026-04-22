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

  it("per-account apiBaseUrl wins over env and default", () => {
    expect(
      resolveTelegramBotApiBaseUrl(
        { TELEGRAM_BOT_API_BASE_URL: "https://env.example" } as NodeJS.ProcessEnv,
        { apiBaseUrl: "https://account.example" },
      ),
    ).toBe("https://account.example");
    expect(
      resolveTelegramBotApiHostname(
        { TELEGRAM_BOT_API_BASE_URL: "https://env.example" } as NodeJS.ProcessEnv,
        { apiBaseUrl: "https://account.example" },
      ),
    ).toBe("account.example");
  });

  it("per-account apiBaseUrl is normalized (trailing slash stripped)", () => {
    expect(
      resolveTelegramBotApiBaseUrl({} as NodeJS.ProcessEnv, {
        apiBaseUrl: "http://127.0.0.1:9000///",
      }),
    ).toBe("http://127.0.0.1:9000");
  });

  it("falls through to env when per-account apiBaseUrl is empty / whitespace", () => {
    expect(
      resolveTelegramBotApiBaseUrl(
        { TELEGRAM_BOT_API_BASE_URL: "https://env.example" } as NodeJS.ProcessEnv,
        { apiBaseUrl: "   " },
      ),
    ).toBe("https://env.example");
  });

  it("falls through to default when neither account nor env is set", () => {
    expect(resolveTelegramBotApiBaseUrl({} as NodeJS.ProcessEnv, { apiBaseUrl: undefined })).toBe(
      "https://api.telegram.org",
    );
  });
});
