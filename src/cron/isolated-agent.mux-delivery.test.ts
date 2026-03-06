import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { CliDeps } from "../cli/deps.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob, withTempCronHome } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

function createCliDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    sendMessageSlack: vi.fn(),
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
    ...overrides,
  };
}

describe("runCronIsolatedAgentTurn mux delivery", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
  });

  it("passes the job origin session context into structured telegram mux delivery", async () => {
    await withTempCronHome(async (home) => {
      const storePath = `${home}/.openclaw/sessions/sessions.json`;
      await fs.mkdir(`${home}/.openclaw/sessions`, { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            "agent:main:main": {
              sessionId: "main-session",
              updatedAt: Date.now(),
              lastChannel: "telegram",
              lastProvider: "telegram",
              lastTo: "123",
              lastAccountId: "default",
            },
            "agent:main:telegram:direct:123": {
              sessionId: "mux-session",
              updatedAt: Date.now(),
              lastChannel: "telegram",
              lastProvider: "telegram",
              lastTo: "123",
              lastAccountId: "mux",
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "caption", mediaUrl: "https://example.com/image.png" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "123",
      });
      const deps = createCliDeps({ sendMessageTelegram: sendTelegram });
      const cfg = makeCfg(home, storePath, {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "default-token" },
              mux: {
                botToken: "mux-token",
                mux: { enabled: true },
              },
            },
          },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          sessionKey: "agent:main:telegram:direct:123",
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(sendTelegram).toHaveBeenCalledWith(
        "123",
        "caption",
        expect.objectContaining({
          accountId: "mux",
          mux: expect.objectContaining({
            sessionKey: "agent:main:telegram:direct:123",
          }),
        }),
      );
    });
  });
});
