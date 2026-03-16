import type { ModelDefinitionConfig } from "../config/types.models.js";

export const REDPILL_BASE_URL = "https://api.redpill.ai/v1";
export const REDPILL_DEFAULT_MODEL_ID = "deepseek/deepseek-v3.2";
export const REDPILL_DEFAULT_MODEL_REF = `redpill/${REDPILL_DEFAULT_MODEL_ID}`;

export type RedpillCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  cost: { input: number; output: number };
};

export const REDPILL_MODEL_CATALOG: ReadonlyArray<RedpillCatalogEntry> = [
  {
    id: "z-ai/glm-4.7-flash",
    name: "GLM 4.7 Flash (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 203_000,
    cost: { input: 0.1, output: 0.43 },
  },
  {
    id: "qwen/qwen3-embedding-8b",
    name: "Qwen3 Embedding 8B (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 33_000,
    cost: { input: 0.01, output: 0 },
  },
  {
    id: "phala/uncensored-24b",
    name: "Uncensored 24B (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 33_000,
    cost: { input: 0.2, output: 0.9 },
  },
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek v3.2 (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 164_000,
    cost: { input: 0.27, output: 0.4 },
  },
  {
    id: "qwen/qwen3-vl-30b-a3b-instruct",
    name: "Qwen3 VL 30B (GPU TEE)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    cost: { input: 0.2, output: 0.7 },
  },
  {
    id: "sentence-transformers/all-minilm-l6-v2",
    name: "All-MiniLM-L6-v2 (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 512,
    cost: { input: 0.005, output: 0 },
  },
  {
    id: "qwen/qwen-2.5-7b-instruct",
    name: "Qwen 2.5 7B Instruct (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 33_000,
    cost: { input: 0.04, output: 0.1 },
  },
  {
    id: "google/gemma-3-27b-it",
    name: "Gemma 3 27B IT (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 54_000,
    cost: { input: 0.11, output: 0.4 },
  },
  {
    id: "openai/gpt-oss-120b",
    name: "GPT OSS 120B (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_000,
    cost: { input: 0.1, output: 0.49 },
  },
  {
    id: "openai/gpt-oss-20b",
    name: "GPT OSS 20B (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_000,
    cost: { input: 0.04, output: 0.15 },
  },
  {
    id: "moonshotai/kimi-k2-thinking",
    name: "Kimi K2 Thinking (GPU TEE)",
    reasoning: true,
    input: ["text"],
    contextWindow: 262_000,
    cost: { input: 2.0, output: 2.0 },
  },
  {
    id: "deepseek/deepseek-r1-0528",
    name: "DeepSeek R1 (GPU TEE)",
    reasoning: true,
    input: ["text"],
    contextWindow: 164_000,
    cost: { input: 2.0, output: 2.0 },
  },
  {
    id: "qwen/qwen3-coder-480b-a35b-instruct",
    name: "Qwen3 Coder 480B (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 262_000,
    cost: { input: 2.0, output: 2.0 },
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B Instruct (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_000,
    cost: { input: 2.0, output: 2.0 },
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5 (GPU TEE)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 262_000,
    cost: { input: 0.6, output: 3.0 },
  },
  {
    id: "minimax/minimax-m2.1",
    name: "MiniMax M2.1 (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 197_000,
    cost: { input: 0.3, output: 1.2 },
  },
  {
    id: "deepseek/deepseek-chat-v3.1",
    name: "DeepSeek Chat v3.1 (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 164_000,
    cost: { input: 1.0, output: 2.5 },
  },
  {
    id: "qwen/qwen3-30b-a3b-instruct-2507",
    name: "Qwen3 30B Instruct (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 262_000,
    cost: { input: 0.15, output: 0.45 },
  },
  {
    id: "z-ai/glm-4.7",
    name: "GLM 4.7 (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_000,
    cost: { input: 0.85, output: 3.3 },
  },
] as const;

function buildRedpillModelDefinition(entry: RedpillCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: {
      input: entry.cost.input,
      output: entry.cost.output,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: entry.contextWindow,
    maxTokens: Math.floor(entry.contextWindow * 0.8),
  };
}

let cachedModels: ModelDefinitionConfig[] | undefined;

export function discoverRedpillModels(): ModelDefinitionConfig[] {
  if (!cachedModels) {
    cachedModels = REDPILL_MODEL_CATALOG.map(buildRedpillModelDefinition);
  }
  return cachedModels;
}

export function resetRedpillModelCache() {
  cachedModels = undefined;
}
