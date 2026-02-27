import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeProviders } from "./models-config.providers.js";

function makeModel(id: string) {
  return {
    id,
    name: id,
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

describe("openai-codex provider normalization", () => {
  it("defaults openai-codex provider api to openai-codex-responses", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = normalizeProviders({
      agentDir,
      providers: {
        "openai-codex": {
          baseUrl: "https://proxy.example.com/v1",
          models: [makeModel("gpt-5.3-codex")],
        },
      },
    });

    expect(providers?.["openai-codex"]?.api).toBe("openai-codex-responses");
  });

  it("keeps explicit provider api when openai-codex api is set", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = normalizeProviders({
      agentDir,
      providers: {
        "openai-codex": {
          baseUrl: "https://proxy.example.com/v1",
          api: "openai-responses",
          models: [makeModel("gpt-5.3-codex")],
        },
      },
    });

    expect(providers?.["openai-codex"]?.api).toBe("openai-responses");
  });
});
