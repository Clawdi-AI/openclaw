/**
 * Per-account `apiBaseUrl` routing for Telegram (plan #1, phase 2).
 *
 * Mirrors `discord.per-account-base-url.e2e.test.ts`: two accounts in
 * one OpenClaw config, each with its own `apiBaseUrl`, must route
 * traffic to distinct hosts with zero cross-contamination. The
 * precedence rule is the same as Discord — per-account wins over
 * `TELEGRAM_BOT_API_BASE_URL` env wins over `https://api.telegram.org`
 * default.
 *
 * Telegram is simpler than Discord: no gateway, long-poll only. So
 * this test exercises only the REST layer via grammY's `bot.api.*`
 * methods, which grammY dispatches against the `apiRoot` the
 * `createTelegramBot` factory threads in from
 * `resolveTelegramBotApiBaseUrl(process.env, account.config)`.
 */
import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../../src/config/config.js";
import { createTelegramBot } from "../../src/telegram/bot.js";
import { FakeTelegramApi } from "./fake-telegram.js";

const TOKEN_A = "10000001:AAA_account_a_token_valid_shape";
const TOKEN_B = "10000002:BBB_account_b_token_valid_shape";

describe("Telegram per-account apiBaseUrl", () => {
  test("each account's grammY Bot routes API calls to its own apiBaseUrl", async () => {
    const fakeA = await FakeTelegramApi.start({ token: TOKEN_A });
    const fakeB = await FakeTelegramApi.start({ token: TOKEN_B });
    try {
      const cfg = {
        channels: {
          telegram: {
            accounts: {
              a: { enabled: true, token: TOKEN_A, apiBaseUrl: fakeA.url },
              b: { enabled: true, token: TOKEN_B, apiBaseUrl: fakeB.url },
            },
          },
        },
      } as OpenClawConfig;

      const botA = createTelegramBot({ token: TOKEN_A, accountId: "a", config: cfg });
      const botB = createTelegramBot({ token: TOKEN_B, accountId: "b", config: cfg });

      await botA.api.sendChatAction(1111, "typing");
      await botB.api.sendChatAction(2222, "typing");

      expect(fakeA.getMethodCalls("sendChatAction")).toEqual([
        expect.objectContaining({
          method: "sendChatAction",
          body: expect.objectContaining({ chat_id: 1111, action: "typing" }),
        }),
      ]);
      expect(fakeB.getMethodCalls("sendChatAction")).toEqual([
        expect.objectContaining({
          method: "sendChatAction",
          body: expect.objectContaining({ chat_id: 2222, action: "typing" }),
        }),
      ]);
    } finally {
      await fakeA.close();
      await fakeB.close();
    }
  });

  test("per-account apiBaseUrl overrides TELEGRAM_BOT_API_BASE_URL env", async () => {
    const fakeEnv = await FakeTelegramApi.start({ token: TOKEN_A });
    const fakeAccount = await FakeTelegramApi.start({ token: TOKEN_A });
    const prevEnv = process.env.TELEGRAM_BOT_API_BASE_URL;
    process.env.TELEGRAM_BOT_API_BASE_URL = fakeEnv.url;
    try {
      const cfg = {
        channels: {
          telegram: {
            accounts: {
              overridden: {
                enabled: true,
                token: TOKEN_A,
                apiBaseUrl: fakeAccount.url,
              },
            },
          },
        },
      } as OpenClawConfig;

      const bot = createTelegramBot({
        token: TOKEN_A,
        accountId: "overridden",
        config: cfg,
      });
      await bot.api.sendChatAction(3333, "typing");

      expect(fakeAccount.getMethodCalls("sendChatAction")).toHaveLength(1);
      expect(fakeEnv.getMethodCalls("sendChatAction")).toHaveLength(0);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.TELEGRAM_BOT_API_BASE_URL;
      } else {
        process.env.TELEGRAM_BOT_API_BASE_URL = prevEnv;
      }
      await fakeEnv.close();
      await fakeAccount.close();
    }
  });
});
