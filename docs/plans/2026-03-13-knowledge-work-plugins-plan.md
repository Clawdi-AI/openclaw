# Knowledge-Work Plugin Converter — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a work-connectors extension, a converter script, and use it to convert the sales and marketing knowledge-work-plugins into OpenClaw skills.

**Architecture:** A `before_prompt_build` hook injects connector resolution from a single `connectors.json` into every prompt. A converter script reads knowledge-work plugin directories and outputs OpenClaw `skills/<prefix>-<name>/SKILL.md` files with `~~category` references and precise descriptions. Only 2-3 skills embed Lobster workflows; the rest are pure AI-guided.

**Tech Stack:** TypeScript (Node.js), OpenClaw plugin SDK, vitest for tests.

**Design doc:** `docs/plans/2026-03-13-knowledge-work-plugins-design.md`

---

## Task 1: Clone the knowledge-work-plugins repository

**Files:**
- Clone to: `../knowledge-work-plugins` (sibling of openclaw)

**Step 1: Clone the repo**

```bash
cd /Users/hashwarlock/Projects/Clawdi
git clone https://github.com/anthropics/knowledge-work-plugins.git
```

**Step 2: Verify structure**

```bash
ls knowledge-work-plugins/sales/.claude-plugin/plugin.json
ls knowledge-work-plugins/sales/.mcp.json
ls knowledge-work-plugins/sales/skills/
ls knowledge-work-plugins/sales/commands/
ls knowledge-work-plugins/marketing/skills/
ls knowledge-work-plugins/marketing/commands/
```

Expected: All paths exist with `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, and `commands/` directories.

**Step 3: Commit note**

No commit needed — external dependency, not part of openclaw.

---

## Task 2: Create the work-connectors extension — manifest and package.json

**Files:**
- Create: `extensions/work-connectors/openclaw.plugin.json`
- Create: `extensions/work-connectors/package.json`
- Create: `extensions/work-connectors/connectors.json`

**Step 1: Create `extensions/work-connectors/openclaw.plugin.json`**

```json
{
  "id": "work-connectors",
  "name": "Work Connectors",
  "description": "Injects ~~category connector resolution into every prompt.",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Follow the pattern from `extensions/lobster/openclaw.plugin.json`.

**Step 2: Create `extensions/work-connectors/package.json`**

```json
{
  "name": "@openclaw/work-connectors",
  "version": "2026.2.17",
  "description": "Hook-based ~~category connector resolution for knowledge-work skills",
  "type": "module",
  "devDependencies": {
    "openclaw": "workspace:*"
  },
  "openclaw": {
    "extensions": [
      "./index.ts"
    ]
  }
}
```

Follow the pattern from `extensions/lobster/package.json`.

**Step 3: Create `extensions/work-connectors/connectors.json`**

```json
{
  "connectors": {
    "~~crm": { "backend": "composio", "ref": "clawdi-mcp.HUBSPOT_*" },
    "~~chat": { "backend": "skill", "ref": "slack" },
    "~~email": { "backend": "composio", "ref": "clawdi-mcp.GOOGLESUPER_*" },
    "~~enrichment": { "backend": "mcporter", "ref": "zoominfo" },
    "~~docs": { "backend": "composio", "ref": "clawdi-mcp.NOTION_*" },
    "~~tracker": { "backend": "composio", "ref": "clawdi-mcp.LINEAR_*" },
    "~~calendar": { "backend": "composio", "ref": "clawdi-mcp.GOOGLESUPER_*" },
    "~~analytics": { "backend": "mcporter", "ref": "amplitude" },
    "~~design": { "backend": "mcporter", "ref": "figma" },
    "~~calls": { "backend": "mcporter", "ref": "fireflies" }
  }
}
```

**Step 4: Commit**

```bash
git add extensions/work-connectors/openclaw.plugin.json extensions/work-connectors/package.json extensions/work-connectors/connectors.json
git commit -m "feat(work-connectors): add extension manifest and default connectors config"
```

---

## Task 3: Write the failing test for the work-connectors hook

**Files:**
- Create: `extensions/work-connectors/src/hook.test.ts`

**Step 1: Write the test**

```typescript
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We'll test the core formatting logic, not the plugin registration
let formatConnectorsPrompt: typeof import("./hook.js").formatConnectorsPrompt;
let loadConnectors: typeof import("./hook.js").loadConnectors;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("./hook.js");
  formatConnectorsPrompt = mod.formatConnectorsPrompt;
  loadConnectors = mod.loadConnectors;
});

describe("work-connectors hook", () => {
  it("formats connectors into a prompt block", () => {
    const connectors = {
      "~~crm": { backend: "composio", ref: "clawdi-mcp.HUBSPOT_*" },
      "~~chat": { backend: "skill", ref: "slack" },
    };
    const result = formatConnectorsPrompt(connectors);
    expect(result).toContain("~~crm");
    expect(result).toContain("composio");
    expect(result).toContain("~~chat");
    expect(result).toContain("skill");
    expect(result).toContain("Connector Resolution");
  });

  it("returns empty string for empty connectors", () => {
    const result = formatConnectorsPrompt({});
    expect(result).toBe("");
  });

  it("returns empty string for null/undefined", () => {
    const result = formatConnectorsPrompt(undefined as any);
    expect(result).toBe("");
  });

  it("loadConnectors reads and parses connectors.json", () => {
    const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname ?? ".", "test-"));
    const filePath = path.join(tmpDir, "connectors.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        connectors: {
          "~~crm": { backend: "mcporter", ref: "hubspot" },
        },
      }),
    );
    const result = loadConnectors(filePath);
    expect(result).toEqual({ "~~crm": { backend: "mcporter", ref: "hubspot" } });
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("loadConnectors returns empty object for missing file", () => {
    const result = loadConnectors("/nonexistent/path/connectors.json");
    expect(result).toEqual({});
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
cd /Users/hashwarlock/Projects/Clawdi/openclaw
npx vitest run extensions/work-connectors/src/hook.test.ts
```

Expected: FAIL — `./hook.js` module does not exist.

---

## Task 4: Implement the work-connectors hook logic

**Files:**
- Create: `extensions/work-connectors/src/hook.ts`

**Step 1: Implement the hook module**

```typescript
import fs from "node:fs";

type ConnectorEntry = {
  backend: string;
  ref: string;
};

type ConnectorsMap = Record<string, ConnectorEntry>;

export function loadConnectors(filePath: string): ConnectorsMap {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { connectors?: ConnectorsMap };
    if (parsed.connectors && typeof parsed.connectors === "object") {
      return parsed.connectors;
    }
    return {};
  } catch {
    return {};
  }
}

export function formatConnectorsPrompt(connectors: ConnectorsMap | undefined | null): string {
  if (!connectors || typeof connectors !== "object") {
    return "";
  }
  const entries = Object.entries(connectors);
  if (entries.length === 0) {
    return "";
  }

  const lines = entries.map(([category, entry]) => {
    if (entry.backend === "skill") {
      return `- ${category}: use the ${entry.ref} skill`;
    }
    if (entry.backend === "mcporter") {
      return `- ${category}: use mcporter call ${entry.ref}.<tool_name> key=value`;
    }
    if (entry.backend === "composio") {
      return `- ${category}: use composio (${entry.ref})`;
    }
    return `- ${category}: ${entry.backend} (${entry.ref})`;
  });

  return [
    "## Connector Resolution",
    "When a skill references a ~~category, use this mapping:",
    ...lines,
    "",
    'If a connector is listed as "skill:<name>", use that OpenClaw skill\'s actions directly.',
    'If a connector is listed as "mcporter", use: mcporter call <ref>.<tool_name> key=value',
    'If a connector is listed as "composio", use the composio skill workflow (search -> connect -> execute).',
    "If a ~~category has no mapping configured, tell the user what to add to connectors.json.",
  ].join("\n");
}
```

**Step 2: Run the test to verify it passes**

```bash
npx vitest run extensions/work-connectors/src/hook.test.ts
```

Expected: All 5 tests PASS.

**Step 3: Commit**

```bash
git add extensions/work-connectors/src/hook.ts extensions/work-connectors/src/hook.test.ts
git commit -m "feat(work-connectors): add connector loading and prompt formatting with tests"
```

---

## Task 5: Wire up the extension entry point

**Files:**
- Create: `extensions/work-connectors/index.ts`

**Step 1: Implement the entry point**

```typescript
import path from "node:path";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { formatConnectorsPrompt, loadConnectors } from "./src/hook.js";

export default function register(api: OpenClawPluginApi) {
  const connectorsPath = path.join(api.resolvePath("."), "connectors.json");
  const connectors = loadConnectors(connectorsPath);

  if (Object.keys(connectors).length === 0) {
    api.logger.info("work-connectors: no connectors configured, skipping hook registration");
    return;
  }

  const prompt = formatConnectorsPrompt(connectors);
  if (!prompt) {
    return;
  }

  api.on("before_prompt_build", () => {
    return { prependContext: prompt };
  });

  api.logger.info(
    `work-connectors: registered ${Object.keys(connectors).length} connector(s) for prompt injection`,
  );
}
```

Follow the pattern from `extensions/lobster/index.ts`.

**Step 2: Verify the extension loads**

The extension entry point is referenced by `package.json` `openclaw.extensions` field (already set in Task 2). To verify structurally:

```bash
ls extensions/work-connectors/index.ts extensions/work-connectors/src/hook.ts extensions/work-connectors/openclaw.plugin.json extensions/work-connectors/package.json extensions/work-connectors/connectors.json
```

Expected: All 5 files exist.

**Step 3: Commit**

```bash
git add extensions/work-connectors/index.ts
git commit -m "feat(work-connectors): wire up before_prompt_build hook entry point"
```

---

## Task 6: Write the failing test for the converter script — frontmatter parsing

**Files:**
- Create: `scripts/convert-knowledge-work.test.ts`

The converter script is the most complex piece. We'll build it test-first in stages.

**Step 1: Write the first test — frontmatter transformation**

```typescript
import { describe, expect, it } from "vitest";
import {
  transformFrontmatter,
  type KnowledgeWorkSkill,
} from "./convert-knowledge-work.js";

describe("convert-knowledge-work", () => {
  describe("transformFrontmatter", () => {
    it("converts knowledge-work YAML frontmatter to OpenClaw format", () => {
      const input: KnowledgeWorkSkill = {
        name: "account-research",
        description: "Research a company or person",
        body: "# Account Research\n\nContent here",
      };
      const result = transformFrontmatter(input, "sales", "🔍");
      expect(result.name).toBe("sales-account-research");
      expect(result.description).toContain("Research a company or person");
      expect(result.description).not.toContain("~~");
      expect(result.metadata).toContain('"openclaw"');
      expect(result.metadata).toContain("🔍");
    });

    it("prefixes skill name with plugin prefix", () => {
      const input: KnowledgeWorkSkill = {
        name: "call-prep",
        description: "Prepare for a sales call",
        body: "",
      };
      const result = transformFrontmatter(input, "sales", "📞");
      expect(result.name).toBe("sales-call-prep");
    });
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
npx vitest run scripts/convert-knowledge-work.test.ts
```

Expected: FAIL — module does not exist.

---

## Task 7: Implement converter — frontmatter transformation

**Files:**
- Create: `scripts/convert-knowledge-work.ts`

**Step 1: Implement the initial module with frontmatter transformation**

```typescript
import fs from "node:fs";
import path from "node:path";

export type KnowledgeWorkSkill = {
  name: string;
  description: string;
  body: string;
  quickref?: string;
};

export type OpenClawSkillFrontmatter = {
  name: string;
  description: string;
  metadata: string;
};

export function transformFrontmatter(
  skill: KnowledgeWorkSkill,
  prefix: string,
  emoji: string,
): OpenClawSkillFrontmatter {
  const name = `${prefix}-${skill.name}`;
  // Strip ~~ from description (keep plain language in descriptions)
  const description = skill.description.replace(/~~\w+/g, (match) => {
    const word = match.slice(2);
    return word;
  });
  const metadata = `{ "openclaw": { "emoji": "${emoji}" } }`;
  return { name, description, metadata };
}

export function parseFrontmatterFromMd(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const raw = match[1];
  const body = match[2];
  const frontmatter: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body };
}

export function renderOpenClawSkillMd(
  fm: OpenClawSkillFrontmatter,
  body: string,
): string {
  return [
    "---",
    `name: ${fm.name}`,
    `description: ${JSON.stringify(fm.description)}`,
    `metadata: ${fm.metadata}`,
    "---",
    "",
    body,
  ].join("\n");
}
```

**Step 2: Run the test to verify it passes**

```bash
npx vitest run scripts/convert-knowledge-work.test.ts
```

Expected: PASS.

**Step 3: Commit**

```bash
git add scripts/convert-knowledge-work.ts scripts/convert-knowledge-work.test.ts
git commit -m "feat(converter): add frontmatter parsing and transformation"
```

---

## Task 8: Write the failing test for the converter — MCP server mapping

**Files:**
- Modify: `scripts/convert-knowledge-work.test.ts`

**Step 1: Add the MCP mapping test**

Append to `scripts/convert-knowledge-work.test.ts`:

```typescript
import { mapMcpServerToCategory } from "./convert-knowledge-work.js";

describe("mapMcpServerToCategory", () => {
  it("maps known MCP servers to ~~categories", () => {
    expect(mapMcpServerToCategory("hubspot")).toBe("~~crm");
    expect(mapMcpServerToCategory("close")).toBe("~~crm");
    expect(mapMcpServerToCategory("slack")).toBe("~~chat");
    expect(mapMcpServerToCategory("ms365")).toBe("~~email");
    expect(mapMcpServerToCategory("notion")).toBe("~~docs");
    expect(mapMcpServerToCategory("zoominfo")).toBe("~~enrichment");
    expect(mapMcpServerToCategory("linear")).toBe("~~tracker");
    expect(mapMcpServerToCategory("amplitude")).toBe("~~analytics");
    expect(mapMcpServerToCategory("figma")).toBe("~~design");
    expect(mapMcpServerToCategory("fireflies")).toBe("~~calls");
  });

  it("returns null for unknown servers", () => {
    expect(mapMcpServerToCategory("unknown-server")).toBeNull();
  });
});
```

**Step 2: Run and verify failure**

```bash
npx vitest run scripts/convert-knowledge-work.test.ts
```

Expected: FAIL — `mapMcpServerToCategory` is not exported.

---

## Task 9: Implement the MCP server mapping

**Files:**
- Modify: `scripts/convert-knowledge-work.ts`

**Step 1: Add the mapping function**

Append to `scripts/convert-knowledge-work.ts`:

```typescript
const MCP_CATEGORY_MAP: Record<string, string> = {
  hubspot: "~~crm",
  close: "~~crm",
  salesforce: "~~crm",
  slack: "~~chat",
  ms365: "~~email",
  gmail: "~~email",
  notion: "~~docs",
  atlassian: "~~docs",
  guru: "~~docs",
  zoominfo: "~~enrichment",
  clay: "~~enrichment",
  linear: "~~tracker",
  asana: "~~tracker",
  monday: "~~tracker",
  clickup: "~~tracker",
  amplitude: "~~analytics",
  pendo: "~~analytics",
  figma: "~~design",
  canva: "~~design",
  fireflies: "~~calls",
};

export function mapMcpServerToCategory(serverName: string): string | null {
  return MCP_CATEGORY_MAP[serverName.toLowerCase()] ?? null;
}
```

**Step 2: Run and verify pass**

```bash
npx vitest run scripts/convert-knowledge-work.test.ts
```

Expected: All tests PASS.

**Step 3: Commit**

```bash
git add scripts/convert-knowledge-work.ts scripts/convert-knowledge-work.test.ts
git commit -m "feat(converter): add MCP server to ~~category mapping"
```

---

## Task 10: Write the failing test for the converter — skill directory reading

**Files:**
- Modify: `scripts/convert-knowledge-work.test.ts`

**Step 1: Add test for reading a knowledge-work plugin directory**

```typescript
import { readKnowledgeWorkPlugin } from "./convert-knowledge-work.js";

describe("readKnowledgeWorkPlugin", () => {
  it("reads plugin metadata, skills, commands, and mcp config", () => {
    // This test uses the actual cloned repo
    const pluginDir = path.resolve(
      import.meta.dirname ?? ".",
      "../../knowledge-work-plugins/sales",
    );
    // Skip if repo not cloned
    if (!fs.existsSync(pluginDir)) {
      console.warn("Skipping: knowledge-work-plugins not cloned");
      return;
    }
    const plugin = readKnowledgeWorkPlugin(pluginDir);
    expect(plugin.name).toBeTruthy();
    expect(plugin.skills.length).toBeGreaterThan(0);
    expect(plugin.mcpServers).toBeTruthy();
    // Sales plugin should have skills like account-research
    const skillNames = plugin.skills.map((s) => s.name);
    expect(skillNames).toContain("account-research");
  });
});
```

**Step 2: Run and verify failure**

```bash
npx vitest run scripts/convert-knowledge-work.test.ts
```

Expected: FAIL — `readKnowledgeWorkPlugin` not exported.

---

## Task 11: Implement the plugin reader

**Files:**
- Modify: `scripts/convert-knowledge-work.ts`

**Step 1: Add the plugin reader**

```typescript
export type McpServerConfig = {
  type: string;
  url: string;
};

export type KnowledgeWorkPlugin = {
  name: string;
  description: string;
  skills: KnowledgeWorkSkill[];
  commands: KnowledgeWorkSkill[];
  mcpServers: Record<string, McpServerConfig>;
};

export function readKnowledgeWorkPlugin(pluginDir: string): KnowledgeWorkPlugin {
  // Read plugin.json
  const pluginJsonPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
  let pluginMeta = { name: path.basename(pluginDir), description: "" };
  if (fs.existsSync(pluginJsonPath)) {
    const raw = JSON.parse(fs.readFileSync(pluginJsonPath, "utf-8")) as Record<string, unknown>;
    pluginMeta = {
      name: (raw.name as string) ?? path.basename(pluginDir),
      description: (raw.description as string) ?? "",
    };
  }

  // Read .mcp.json
  const mcpPath = path.join(pluginDir, ".mcp.json");
  let mcpServers: Record<string, McpServerConfig> = {};
  if (fs.existsSync(mcpPath)) {
    const raw = JSON.parse(fs.readFileSync(mcpPath, "utf-8")) as {
      mcpServers?: Record<string, McpServerConfig>;
    };
    mcpServers = raw.mcpServers ?? {};
  }

  // Read skills
  const skillsDir = path.join(pluginDir, "skills");
  const skills = readSkillsFromDir(skillsDir);

  // Read commands
  const commandsDir = path.join(pluginDir, "commands");
  const commands = readCommandsFromDir(commandsDir);

  return {
    name: pluginMeta.name,
    description: pluginMeta.description,
    skills,
    commands,
    mcpServers,
  };
}

function readSkillsFromDir(dir: string): KnowledgeWorkSkill[] {
  if (!fs.existsSync(dir)) return [];
  const skills: KnowledgeWorkSkill[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    const content = fs.readFileSync(skillMd, "utf-8");
    const { frontmatter, body } = parseFrontmatterFromMd(content);

    // Check for QUICKREF.md
    const quickrefPath = path.join(dir, entry.name, "QUICKREF.md");
    const quickref = fs.existsSync(quickrefPath)
      ? fs.readFileSync(quickrefPath, "utf-8")
      : undefined;

    skills.push({
      name: frontmatter.name ?? entry.name,
      description: frontmatter.description ?? "",
      body: quickref ? `${body}\n\n---\n\n## Quick Reference\n\n${quickref}` : body,
      quickref,
    });
  }
  return skills;
}

function readCommandsFromDir(dir: string): KnowledgeWorkSkill[] {
  if (!fs.existsSync(dir)) return [];
  const commands: KnowledgeWorkSkill[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
    const { frontmatter, body } = parseFrontmatterFromMd(content);
    const name = path.basename(entry.name, ".md");
    commands.push({
      name,
      description: frontmatter.description ?? "",
      body,
    });
  }
  return commands;
}
```

**Step 2: Run and verify pass**

```bash
npx vitest run scripts/convert-knowledge-work.test.ts
```

Expected: All tests PASS (the integration test may skip if repo not cloned yet).

**Step 3: Commit**

```bash
git add scripts/convert-knowledge-work.ts scripts/convert-knowledge-work.test.ts
git commit -m "feat(converter): add knowledge-work plugin reader with skill and command parsing"
```

---

## Task 12: Write the failing test for the converter — full conversion output

**Files:**
- Modify: `scripts/convert-knowledge-work.test.ts`

**Step 1: Add the end-to-end conversion test**

```typescript
import { convertPlugin, type ConversionResult } from "./convert-knowledge-work.js";

describe("convertPlugin", () => {
  it("produces OpenClaw skill files from a knowledge-work plugin", () => {
    const tmpInput = fs.mkdtempSync(path.join(os.tmpdir(), "kwp-input-"));
    const tmpOutput = fs.mkdtempSync(path.join(os.tmpdir(), "kwp-output-"));

    // Set up a minimal knowledge-work plugin
    fs.mkdirSync(path.join(tmpInput, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpInput, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "test-plugin" }),
    );
    fs.writeFileSync(
      path.join(tmpInput, ".mcp.json"),
      JSON.stringify({ mcpServers: { hubspot: { type: "http", url: "https://mcp.hubspot.com" } } }),
    );
    fs.mkdirSync(path.join(tmpInput, "skills", "my-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpInput, "skills", "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: A test skill\n---\n\n# My Skill\n\nUse ~~crm to look up accounts.",
    );
    fs.mkdirSync(path.join(tmpInput, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpInput, "commands", "my-command.md"),
      "---\ndescription: Run a test command\n---\n\n# My Command\n\nDo the thing.",
    );

    const result = convertPlugin({
      inputDir: tmpInput,
      outputDir: tmpOutput,
      prefix: "test",
      emoji: "🧪",
    });

    // Check skill was created
    const skillPath = path.join(tmpOutput, "test-my-skill", "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    const skillContent = fs.readFileSync(skillPath, "utf-8");
    expect(skillContent).toContain("name: test-my-skill");
    expect(skillContent).toContain("~~crm");

    // Check command was created as a skill
    const cmdPath = path.join(tmpOutput, "test-my-command", "SKILL.md");
    expect(fs.existsSync(cmdPath)).toBe(true);

    // Check connector mapping was extracted
    expect(result.connectorMappings["~~crm"]).toBeTruthy();

    // Cleanup
    fs.rmSync(tmpInput, { recursive: true });
    fs.rmSync(tmpOutput, { recursive: true });
  });
});
```

**Step 2: Run and verify failure**

```bash
npx vitest run scripts/convert-knowledge-work.test.ts
```

Expected: FAIL — `convertPlugin` not exported.

---

## Task 13: Implement the full conversion function

**Files:**
- Modify: `scripts/convert-knowledge-work.ts`

**Step 1: Add the conversion function**

```typescript
export type ConversionResult = {
  skillsWritten: string[];
  commandsWritten: string[];
  connectorMappings: Record<string, { backend: string; ref: string }>;
  warnings: string[];
};

export function convertPlugin(params: {
  inputDir: string;
  outputDir: string;
  prefix: string;
  emoji: string;
}): ConversionResult {
  const plugin = readKnowledgeWorkPlugin(params.inputDir);
  const result: ConversionResult = {
    skillsWritten: [],
    commandsWritten: [],
    connectorMappings: {},
    warnings: [],
  };

  // Extract connector mappings from MCP servers
  for (const [serverName, serverConfig] of Object.entries(plugin.mcpServers)) {
    const category = mapMcpServerToCategory(serverName);
    if (category) {
      result.connectorMappings[category] = {
        backend: "mcporter",
        ref: serverName,
      };
    } else {
      result.warnings.push(`Unknown MCP server: ${serverName} (${serverConfig.url}) — needs manual ~~category mapping`);
    }
  }

  // Convert skills
  for (const skill of plugin.skills) {
    const fm = transformFrontmatter(skill, params.prefix, params.emoji);
    const content = renderOpenClawSkillMd(fm, skill.body);
    const skillDir = path.join(params.outputDir, fm.name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), content);
    result.skillsWritten.push(fm.name);
  }

  // Convert commands to skills
  for (const command of plugin.commands) {
    const fm = transformFrontmatter(command, params.prefix, params.emoji);
    const content = renderOpenClawSkillMd(fm, command.body);
    const skillDir = path.join(params.outputDir, fm.name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), content);
    result.commandsWritten.push(fm.name);
  }

  return result;
}
```

**Step 2: Run and verify pass**

```bash
npx vitest run scripts/convert-knowledge-work.test.ts
```

Expected: All tests PASS.

**Step 3: Commit**

```bash
git add scripts/convert-knowledge-work.ts scripts/convert-knowledge-work.test.ts
git commit -m "feat(converter): add full plugin conversion with skill/command output and connector extraction"
```

---

## Task 14: Add the CLI entry point to the converter script

**Files:**
- Modify: `scripts/convert-knowledge-work.ts`

**Step 1: Add CLI argument parsing at the end of the file**

```typescript
// CLI entry point — only runs when executed directly
const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("convert-knowledge-work.ts") ||
    process.argv[1].endsWith("convert-knowledge-work.js"));

if (isMainModule) {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf("--input");
  const prefixIdx = args.indexOf("--prefix");
  const outputIdx = args.indexOf("--output");
  const emojiIdx = args.indexOf("--emoji");

  const inputDir = inputIdx !== -1 ? args[inputIdx + 1] : undefined;
  const prefix = prefixIdx !== -1 ? args[prefixIdx + 1] : undefined;
  const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : "skills";
  const emoji = emojiIdx !== -1 ? args[emojiIdx + 1] : "💼";

  if (!inputDir || !prefix) {
    console.error("Usage: convert-knowledge-work --input <plugin-dir> --prefix <prefix> [--output <dir>] [--emoji <emoji>]");
    process.exit(1);
  }

  const resolvedInput = path.resolve(inputDir);
  const resolvedOutput = path.resolve(outputDir);

  console.log(`Converting: ${resolvedInput}`);
  console.log(`Prefix: ${prefix}`);
  console.log(`Output: ${resolvedOutput}`);

  const result = convertPlugin({
    inputDir: resolvedInput,
    outputDir: resolvedOutput,
    prefix,
    emoji,
  });

  console.log(`\nSkills written (${result.skillsWritten.length}):`);
  for (const name of result.skillsWritten) {
    console.log(`  ✓ ${name}`);
  }
  console.log(`\nCommands converted to skills (${result.commandsWritten.length}):`);
  for (const name of result.commandsWritten) {
    console.log(`  ✓ ${name}`);
  }
  if (Object.keys(result.connectorMappings).length > 0) {
    console.log(`\nConnector mappings extracted:`);
    for (const [category, mapping] of Object.entries(result.connectorMappings)) {
      console.log(`  ${category} → ${mapping.backend}:${mapping.ref}`);
    }
  }
  if (result.warnings.length > 0) {
    console.log(`\nWarnings:`);
    for (const warning of result.warnings) {
      console.log(`  ⚠ ${warning}`);
    }
  }
  console.log("\nDone. Review generated skills and update connectors.json as needed.");
}
```

**Step 2: Verify the CLI runs (dry run)**

```bash
node --import tsx scripts/convert-knowledge-work.ts --help 2>&1 || true
```

Expected: Shows usage error (no --input provided).

**Step 3: Commit**

```bash
git add scripts/convert-knowledge-work.ts
git commit -m "feat(converter): add CLI entry point with argument parsing"
```

---

## Task 15: Run the converter against the sales plugin

**Files:**
- Create: `skills/sales-*/SKILL.md` (generated)

**Step 1: Run the converter**

```bash
cd /Users/hashwarlock/Projects/Clawdi/openclaw
node --import tsx scripts/convert-knowledge-work.ts \
  --input ../knowledge-work-plugins/sales \
  --prefix sales \
  --output skills \
  --emoji "💰"
```

**Step 2: Verify output**

```bash
ls skills/sales-*/SKILL.md
```

Expected: 7+ SKILL.md files matching the sales plugin skills and commands.

**Step 3: Spot-check a generated skill**

```bash
cat skills/sales-account-research/SKILL.md
```

Expected: OpenClaw-formatted SKILL.md with `~~crm` references in body, clean description without `~~` in frontmatter.

**Step 4: Commit**

```bash
git add skills/sales-*/SKILL.md
git commit -m "feat: add converted sales skills from knowledge-work-plugins"
```

---

## Task 16: Run the converter against the marketing plugin

**Files:**
- Create: `skills/marketing-*/SKILL.md` (generated)

**Step 1: Run the converter**

```bash
node --import tsx scripts/convert-knowledge-work.ts \
  --input ../knowledge-work-plugins/marketing \
  --prefix marketing \
  --output skills \
  --emoji "📣"
```

**Step 2: Verify output**

```bash
ls skills/marketing-*/SKILL.md
```

**Step 3: Commit**

```bash
git add skills/marketing-*/SKILL.md
git commit -m "feat: add converted marketing skills from knowledge-work-plugins"
```

---

## Task 17: Review and refine skill descriptions

This is a manual review task. For each generated skill:

**Step 1: List all generated skills**

```bash
grep -r "^description:" skills/sales-*/SKILL.md skills/marketing-*/SKILL.md
```

**Step 2: For each description, verify:**

- States what the skill does in one sentence
- Includes 2-3 positive trigger phrases
- Includes explicit exclusions ("NOT for...")
- Does NOT contain `~~` syntax
- Is distinct from every other skill's description
- Is distinct from existing skills (slack, composio, coding-agent, etc.)

**Step 3: Edit descriptions that need refinement**

Edit each `SKILL.md` frontmatter `description` field manually. Pay special attention to:
- `sales-draft-outreach` vs `marketing-content-create` (both create written content)
- `sales-daily-briefing` vs any productivity-related skills
- `sales-account-research` vs general web search

**Step 4: Commit**

```bash
git add skills/sales-*/SKILL.md skills/marketing-*/SKILL.md
git commit -m "refine: improve skill descriptions for routing precision"
```

---

## Task 18: Add Lobster workflow to sales-pipeline-review

**Files:**
- Modify: `skills/sales-pipeline-review/SKILL.md`

**Step 1: Check if sales-pipeline-review was generated**

```bash
cat skills/sales-pipeline-review/SKILL.md
```

**Step 2: Add Lobster workflow section and requires metadata**

Update the frontmatter to add Lobster dependency:

```yaml
metadata: { "openclaw": { "emoji": "📊", "requires": { "bins": ["lobster"] } } }
```

Add a workflow section to the body:

```markdown
## Deterministic Pipeline (Lobster)

For structured pipeline data, use the lobster tool:

```json
{
  "action": "run",
  "pipeline": "~~crm.list_deals --stage open --limit 50 | sales.score-deals | approve --prompt 'Review these scored deals?'"
}
```

If lobster is not available, follow the manual steps above using ~~crm directly.
```

**Step 3: Commit**

```bash
git add skills/sales-pipeline-review/SKILL.md
git commit -m "feat: add Lobster workflow to sales-pipeline-review skill"
```

---

## Task 19: Update connectors.json with extracted mappings

**Files:**
- Modify: `extensions/work-connectors/connectors.json`

**Step 1: Review the connector mappings extracted by both conversion runs**

Check the converter output from Tasks 15 and 16 for the connector mappings logged.

**Step 2: Update connectors.json**

Merge any new connectors found in the marketing plugin's `.mcp.json` that weren't in the default config. Expected additions from marketing: `canva`, `ahrefs`, `similarweb`, `klaviyo`.

Add them under existing or new categories as appropriate.

**Step 3: Commit**

```bash
git add extensions/work-connectors/connectors.json
git commit -m "feat(work-connectors): update connector mappings with sales and marketing MCP servers"
```

---

## Task 20: Run all tests and final verification

**Step 1: Run the extension tests**

```bash
npx vitest run extensions/work-connectors/src/hook.test.ts
```

Expected: All PASS.

**Step 2: Run the converter tests**

```bash
npx vitest run scripts/convert-knowledge-work.test.ts
```

Expected: All PASS.

**Step 3: Run the full extension test suite (ensure nothing is broken)**

```bash
npx vitest run --config vitest.extensions.config.ts
```

Expected: All existing tests still PASS.

**Step 4: Verify skill count**

```bash
ls -d skills/sales-*/SKILL.md skills/marketing-*/SKILL.md | wc -l
```

Expected: 12-15 skills total.

**Step 5: Verify connector injection format**

```bash
node --import tsx -e "
  import { loadConnectors, formatConnectorsPrompt } from './extensions/work-connectors/src/hook.js';
  const c = loadConnectors('./extensions/work-connectors/connectors.json');
  console.log(formatConnectorsPrompt(c));
"
```

Expected: Clean formatted connector resolution block.

**Step 6: Final commit**

No code changes — this is a verification step. If everything passes, the implementation is complete.
