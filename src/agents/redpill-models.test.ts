import { beforeEach, describe, expect, it } from "vitest";
import {
  discoverRedpillModels,
  REDPILL_BASE_URL,
  REDPILL_DEFAULT_MODEL_ID,
  REDPILL_DEFAULT_MODEL_REF,
  REDPILL_MODEL_CATALOG,
  resetRedpillModelCache,
} from "./redpill-models.js";

describe("redpill-models", () => {
  beforeEach(() => {
    resetRedpillModelCache();
  });

  it("exports the expected Redpill defaults", () => {
    expect(REDPILL_BASE_URL).toBe("https://api.redpill.ai/v1");
    expect(REDPILL_DEFAULT_MODEL_ID).toBe("deepseek/deepseek-v3.2");
    expect(REDPILL_DEFAULT_MODEL_REF).toBe("redpill/deepseek/deepseek-v3.2");
  });

  it("includes the donor GPU TEE catalog", () => {
    const ids = REDPILL_MODEL_CATALOG.map((model) => model.id);
    expect(ids).toContain("deepseek/deepseek-v3.2");
    expect(ids).toContain("qwen/qwen3-vl-30b-a3b-instruct");
    expect(ids).toContain("sentence-transformers/all-minilm-l6-v2");
    expect(ids).toHaveLength(19);
  });

  it("converts catalog entries into model definitions", () => {
    const models = discoverRedpillModels();
    const deepseek = models.find((model) => model.id === REDPILL_DEFAULT_MODEL_ID);
    const embedding = models.find((model) => model.id === "sentence-transformers/all-minilm-l6-v2");

    expect(models).toHaveLength(19);
    expect(deepseek).toMatchObject({
      name: "DeepSeek v3.2 (GPU TEE)",
      reasoning: false,
      input: ["text"],
      contextWindow: 164_000,
      maxTokens: Math.floor(164_000 * 0.8),
    });
    expect(embedding?.maxTokens).toBe(Math.floor(512 * 0.8));
    expect(embedding?.cost).toEqual({
      input: 0.005,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("caches discovered models until reset", () => {
    const first = discoverRedpillModels();
    const second = discoverRedpillModels();
    expect(second).toBe(first);

    resetRedpillModelCache();
    const third = discoverRedpillModels();
    expect(third).not.toBe(first);
    expect(third).toEqual(first);
  });
});
