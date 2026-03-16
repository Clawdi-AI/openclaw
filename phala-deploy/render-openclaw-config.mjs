#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = process.argv[2] || path.join(__dirname, "openclaw.template.json");

const template = fs.readFileSync(templatePath, "utf8");

const hasValue = (value) => typeof value === "string" && value.length > 0;

const replacements = {
  GATEWAY_AUTH_TOKEN: process.env.RENDER_GATEWAY_AUTH_TOKEN || "",
  MUX_BASE_URL: process.env.RENDER_MUX_BASE_URL || "",
  MUX_REGISTER_KEY: process.env.RENDER_MUX_REGISTER_KEY || "",
  MUX_INBOUND_URL: process.env.RENDER_MUX_INBOUND_URL || "",
  MODEL_PRIMARY: process.env.RENDER_MODEL_PRIMARY || "openai-codex/gpt-5.3-codex",
  OPENAI_BASE_URL: process.env.RENDER_OPENAI_BASE_URL || "",
  OPENAI_API_KEY: process.env.RENDER_OPENAI_API_KEY || "",
  OPENAI_HEADER_API_KEY: process.env.RENDER_OPENAI_HEADER_API_KEY || "",
  CODEX_API_ENDPOINT: process.env.RENDER_CODEX_API_ENDPOINT || "",
  CODEX_API_KEY: process.env.RENDER_CODEX_API_KEY || "",
  CODEX_HEADER_API_KEY: process.env.RENDER_CODEX_HEADER_API_KEY || "",
  BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY || "",
  BRAVE_SEARCH_BASE_URL: process.env.BRAVE_SEARCH_BASE_URL || "",
  PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY || "",
  PERPLEXITY_BASE_URL: process.env.PERPLEXITY_BASE_URL || "",
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY || "",
  FIRECRAWL_BASE_URL: process.env.FIRECRAWL_BASE_URL || "",
};

replacements.WEB_SEARCH_ENABLED =
  hasValue(replacements.BRAVE_SEARCH_API_KEY) ||
  hasValue(replacements.BRAVE_SEARCH_BASE_URL) ||
  hasValue(replacements.PERPLEXITY_API_KEY) ||
  hasValue(replacements.PERPLEXITY_BASE_URL);
replacements.WEB_SEARCH_PROVIDER = "brave";
replacements.FIRECRAWL_ENABLED =
  hasValue(replacements.FIRECRAWL_API_KEY) || hasValue(replacements.FIRECRAWL_BASE_URL);

let rendered = template;
for (const [name, value] of Object.entries(replacements)) {
  rendered = rendered.split(`"__${name}__"`).join(JSON.stringify(value));
}

const unresolved = rendered.match(/"__[A-Z0-9_]+__"/g);
if (unresolved) {
  const names = [...new Set(unresolved)].join(", ");
  throw new Error(`Unresolved placeholders in ${templatePath}: ${names}`);
}

const parsed = JSON.parse(rendered);
process.stdout.write(JSON.stringify(parsed, null, 2));
