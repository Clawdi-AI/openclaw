import { describe, expect, it, vi } from "vitest";
import { DISCORD_BOT_API_BASE_URL_ENV, resolveDiscordApiBaseUrl } from "./api-base-url.js";

describe("resolveDiscordApiBaseUrl", () => {
  it("defaults to discord.com when the env var is unset", () => {
    vi.stubEnv(DISCORD_BOT_API_BASE_URL_ENV, "");
    expect(resolveDiscordApiBaseUrl()).toBe("https://discord.com");
  });

  it("uses DISCORD_BOT_API_BASE_URL without trailing slashes", () => {
    vi.stubEnv(DISCORD_BOT_API_BASE_URL_ENV, "http://127.0.0.1:8080///");
    expect(resolveDiscordApiBaseUrl()).toBe("http://127.0.0.1:8080");
  });

  it("falls back to default when DISCORD_BOT_API_BASE_URL is whitespace", () => {
    vi.stubEnv(DISCORD_BOT_API_BASE_URL_ENV, "   ");
    expect(resolveDiscordApiBaseUrl()).toBe("https://discord.com");
  });

  it("reads from a supplied env map when provided", () => {
    expect(
      resolveDiscordApiBaseUrl({
        [DISCORD_BOT_API_BASE_URL_ENV]: "https://proxy.example",
      } as NodeJS.ProcessEnv),
    ).toBe("https://proxy.example");
  });

  it("per-account apiBaseUrl wins over env and default", () => {
    expect(
      resolveDiscordApiBaseUrl(
        { [DISCORD_BOT_API_BASE_URL_ENV]: "https://env.example" } as NodeJS.ProcessEnv,
        { apiBaseUrl: "https://account.example" },
      ),
    ).toBe("https://account.example");
  });

  it("per-account apiBaseUrl is normalized (trailing slash stripped)", () => {
    expect(
      resolveDiscordApiBaseUrl({} as NodeJS.ProcessEnv, {
        apiBaseUrl: "http://127.0.0.1:9000///",
      }),
    ).toBe("http://127.0.0.1:9000");
  });

  it("falls through to env when per-account apiBaseUrl is empty / whitespace", () => {
    expect(
      resolveDiscordApiBaseUrl(
        { [DISCORD_BOT_API_BASE_URL_ENV]: "https://env.example" } as NodeJS.ProcessEnv,
        { apiBaseUrl: "   " },
      ),
    ).toBe("https://env.example");
  });

  it("falls through to default when neither account nor env is set", () => {
    expect(resolveDiscordApiBaseUrl({} as NodeJS.ProcessEnv, { apiBaseUrl: undefined })).toBe(
      "https://discord.com",
    );
  });
});
