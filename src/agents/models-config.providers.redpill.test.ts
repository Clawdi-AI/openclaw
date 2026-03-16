import { describe, expect, it } from "vitest";
import { buildRedpillProvider } from "./models-config.providers.js";

describe("Redpill provider", () => {
  it("builds the static Redpill provider catalog", () => {
    const provider = buildRedpillProvider();
    const modelIds = provider.models.map((model) => model.id);
    expect(provider.api).toBe("openai-completions");
    expect(provider.baseUrl).toBe("https://api.redpill.ai/v1");
    expect(modelIds).toContain("deepseek/deepseek-v3.2");
    expect(modelIds).toContain("qwen/qwen3-vl-30b-a3b-instruct");
  });
});
