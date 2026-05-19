import { describe, expect, it } from "vitest";
import {
  DISCORD_BOT_API_BASE_URL_ENV,
  resolveDiscordApiBaseUrl,
  resolveDiscordApiHostname,
} from "./api-base-url.js";

describe("resolveDiscordApiBaseUrl", () => {
  it("defaults to real Discord when no source is provided", () => {
    expect(resolveDiscordApiBaseUrl({ env: {} })).toBe("https://discord.com");
  });

  it("reads the env var when no account override is set", () => {
    expect(
      resolveDiscordApiBaseUrl({
        env: { [DISCORD_BOT_API_BASE_URL_ENV]: "https://msg-router.example" },
      }),
    ).toBe("https://msg-router.example");
  });

  it("strips trailing slashes from the env override", () => {
    expect(
      resolveDiscordApiBaseUrl({
        env: { [DISCORD_BOT_API_BASE_URL_ENV]: "https://msg-router.example///" },
      }),
    ).toBe("https://msg-router.example");
  });

  it("falls back to the default when env var is blank/whitespace", () => {
    expect(resolveDiscordApiBaseUrl({ env: { [DISCORD_BOT_API_BASE_URL_ENV]: "   " } })).toBe(
      "https://discord.com",
    );
  });

  it("respects per-account `apiBaseUrl` ahead of the env var", () => {
    expect(
      resolveDiscordApiBaseUrl({
        account: { apiBaseUrl: "https://custom-account.example" },
        env: { [DISCORD_BOT_API_BASE_URL_ENV]: "https://env-override.example" },
      }),
    ).toBe("https://custom-account.example");
  });

  it("falls through to env var when account is missing the field", () => {
    expect(
      resolveDiscordApiBaseUrl({
        account: { apiBaseUrl: undefined },
        env: { [DISCORD_BOT_API_BASE_URL_ENV]: "https://env-override.example" },
      }),
    ).toBe("https://env-override.example");
  });

  it("treats blank account override as absent (falls through to env/default)", () => {
    // Customer-supplied bots leave `apiBaseUrl` unset; m031/m032 only
    // populate it on the platform-routed default account. A literal
    // empty string in config must not collapse the resolver to a
    // malformed `://api/v10/...` URL.
    expect(
      resolveDiscordApiBaseUrl({
        account: { apiBaseUrl: "" },
        env: { [DISCORD_BOT_API_BASE_URL_ENV]: "https://env-override.example" },
      }),
    ).toBe("https://env-override.example");
  });

  it("supports null account (e.g. legacy code paths without per-account context)", () => {
    expect(
      resolveDiscordApiBaseUrl({
        account: null,
        env: { [DISCORD_BOT_API_BASE_URL_ENV]: "https://env-override.example" },
      }),
    ).toBe("https://env-override.example");
  });
});

describe("resolveDiscordApiHostname", () => {
  it("extracts hostname from per-account override", () => {
    expect(
      resolveDiscordApiHostname({
        account: { apiBaseUrl: "https://msg-router.example:4443" },
        env: {},
      }),
    ).toBe("msg-router.example");
  });

  it("falls back to discord.com on malformed URLs", () => {
    expect(
      resolveDiscordApiHostname({
        env: { [DISCORD_BOT_API_BASE_URL_ENV]: "not a url" },
      }),
    ).toBe("discord.com");
  });
});
