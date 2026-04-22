/**
 * Per-account `apiBaseUrl` routing for Discord (plan #1, phase 1).
 *
 * Proves the minimum coexistence invariant: two Discord accounts in one
 * OpenClaw config, each with its own `apiBaseUrl`, route REST traffic
 * to distinct hosts with zero cross-contamination.
 *
 * Uses two isolated `FakeDiscordApi` instances as stand-ins for the two
 * different back-ends (real Discord for one account, msg-router's
 * Discord egress for the other, in a production setup). The test
 * exercises only the REST layer — `createDiscordRestClient` wires
 * Carbon's `RequestClient` with a `baseUrl` pulled from the account.
 * Gateway-URL threading is covered by the unit test in
 * `src/discord/monitor/provider.proxy.test.ts` ("per-account apiBaseUrl
 * wins over DISCORD_BOT_API_BASE_URL for /gateway/bot").
 */
import { Routes } from "discord-api-types/v10";
import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../../src/config/config.js";
import { createDiscordRestClient } from "../../src/discord/client.js";
import { FakeDiscordApi } from "./fake-discord.js";

describe("Discord per-account apiBaseUrl", () => {
  test("each account's REST client routes to its own apiBaseUrl", async () => {
    const fakeA = await FakeDiscordApi.start();
    const fakeB = await FakeDiscordApi.start();
    try {
      const cfg = {
        channels: {
          discord: {
            accounts: {
              a: {
                enabled: true,
                token: "Bot a-account-token",
                apiBaseUrl: fakeA.url,
              },
              b: {
                enabled: true,
                token: "Bot b-account-token",
                apiBaseUrl: fakeB.url,
              },
            },
          },
        },
      } as OpenClawConfig;

      const { rest: restA } = createDiscordRestClient({ cfg, accountId: "a" });
      const { rest: restB } = createDiscordRestClient({ cfg, accountId: "b" });

      // sendMessage POSTs are recorded by FakeDiscordApi; use distinct
      // channel ids per account so each fake's recorded request is
      // unambiguously attributable.
      await restA.post(Routes.channelMessages("channel-for-account-a"), {
        body: { content: "ping from A" },
      });
      await restB.post(Routes.channelMessages("channel-for-account-b"), {
        body: { content: "ping from B" },
      });

      expect(fakeA.requests).toEqual([
        expect.objectContaining({
          kind: "sendMessage",
          channelId: "channel-for-account-a",
          body: expect.objectContaining({ content: "ping from A" }),
        }),
      ]);
      expect(fakeB.requests).toEqual([
        expect.objectContaining({
          kind: "sendMessage",
          channelId: "channel-for-account-b",
          body: expect.objectContaining({ content: "ping from B" }),
        }),
      ]);
    } finally {
      await closeFake(fakeA);
      await closeFake(fakeB);
    }
  });

  test("per-account apiBaseUrl overrides DISCORD_BOT_API_BASE_URL env", async () => {
    const fakeEnv = await FakeDiscordApi.start();
    const fakeAccount = await FakeDiscordApi.start();
    const prevEnv = process.env.DISCORD_BOT_API_BASE_URL;
    process.env.DISCORD_BOT_API_BASE_URL = fakeEnv.url;
    try {
      const cfg = {
        channels: {
          discord: {
            accounts: {
              overridden: {
                enabled: true,
                token: "Bot override-token",
                apiBaseUrl: fakeAccount.url,
              },
            },
          },
        },
      } as OpenClawConfig;

      const { rest } = createDiscordRestClient({ cfg, accountId: "overridden" });
      await rest.post(Routes.channelMessages("some-channel"), {
        body: { content: "account wins over env" },
      });

      expect(fakeAccount.requests).toHaveLength(1);
      expect(fakeEnv.requests).toHaveLength(0);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.DISCORD_BOT_API_BASE_URL;
      } else {
        process.env.DISCORD_BOT_API_BASE_URL = prevEnv;
      }
      await closeFake(fakeEnv);
      await closeFake(fakeAccount);
    }
  });
});

async function closeFake(fake: FakeDiscordApi): Promise<void> {
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  fake.gatewayServer.close();
}
