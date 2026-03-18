/**
 * convert-knowledge-work.ts
 *
 * Converts Anthropic knowledge-work-plugins format into OpenClaw skill format.
 *
 * Usage:
 *   npx tsx scripts/convert-knowledge-work.ts \
 *     --input /path/to/knowledge-work-plugins/sales \
 *     --prefix sales --output skills --emoji 💼
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePlaceholders } from "./knowledge-work/placeholders.js";

// ─── Types ────────────────────────────────────────────────────────

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

export type McpServerConfig = { type: string; url: string };

export type KnowledgeWorkPlugin = {
  name: string;
  description: string;
  skills: KnowledgeWorkSkill[];
  commands: KnowledgeWorkSkill[];
  mcpServers: Record<string, McpServerConfig>;
};

export type ConversionResult = {
  skillsWritten: string[];
  commandsWritten: string[];
  connectorMappings: Record<string, { backend: string; ref: string }>;
  warnings: string[];
};

type BodyTransformResult = {
  body: string;
  warnings: string[];
};

// ─── Part 1: Frontmatter Transformation ───────────────────────────

/**
 * Transform a knowledge-work skill's metadata into OpenClaw frontmatter.
 */
export function transformFrontmatter(
  skill: KnowledgeWorkSkill,
  prefix: string,
  emoji: string,
): OpenClawSkillFrontmatter {
  const name = `${prefix}-${skill.name}`;
  const description = skill.description.replace(/~~/g, "");
  const metadata = JSON.stringify({ openclaw: { emoji } });
  return { name, description, metadata };
}

/**
 * Parse YAML-style frontmatter from a Markdown file.
 * Returns { frontmatter, body }.
 */
export function parseFrontmatterFromMd(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmBlock = trimmed.slice(4, endIdx); // skip "---\n"
  const body = trimmed.slice(endIdx + 4).replace(/^\n/, ""); // skip "\n---\n"

  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

/**
 * Render an OpenClaw SKILL.md with YAML frontmatter and body.
 */
export function renderOpenClawSkillMd(fm: OpenClawSkillFrontmatter, body: string): string {
  // Quote description if it contains colons
  const desc = fm.description.includes(":") ? `"${fm.description}"` : fm.description;

  const lines = [
    "---",
    `name: ${fm.name}`,
    `description: ${desc}`,
    `metadata: '${fm.metadata}'`,
    "---",
    body,
  ];
  return lines.join("\n") + "\n";
}

// ─── Part 2: MCP Server Mapping ──────────────────────────────────

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

/**
 * Map an MCP server name to an OpenClaw connector category.
 * Returns null for unknown servers.
 */
export function mapMcpServerToCategory(serverName: string): string | null {
  return MCP_CATEGORY_MAP[serverName] ?? null;
}

function transformKnowledgeWorkBody(body: string, targetName: string): BodyTransformResult {
  const withoutStaleConnectorNote = body.replace(
    /^.*If you see unfamiliar placeholders.*CONNECTORS\.md.*\n?/gim,
    "",
  );
  const normalized = normalizePlaceholders(withoutStaleConnectorNote);

  return {
    body: normalized.text,
    warnings: normalized.unknownPlaceholders.map(
      (placeholder) => `Unresolved placeholder in ${targetName}: ${placeholder}`,
    ),
  };
}

// ─── Part 3: Plugin Reader ────────────────────────────────────────

/**
 * Read a knowledge-work plugin directory and return its structured data.
 */
export function readKnowledgeWorkPlugin(pluginDir: string): KnowledgeWorkPlugin {
  // Read plugin.json
  const pluginJsonPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf-8"));

  // Read .mcp.json
  let mcpServers: Record<string, McpServerConfig> = {};
  const mcpJsonPath = path.join(pluginDir, ".mcp.json");
  if (fs.existsSync(mcpJsonPath)) {
    const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
    mcpServers = mcpJson.mcpServers ?? {};
  }

  // Read skills
  const skills: KnowledgeWorkSkill[] = [];
  const skillsDir = path.join(pluginDir, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir)) {
      const skillDir = path.join(skillsDir, entry);
      if (!fs.statSync(skillDir).isDirectory()) {
        continue;
      }

      const skillMdPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) {
        continue;
      }

      const raw = fs.readFileSync(skillMdPath, "utf-8");
      const { frontmatter, body } = parseFrontmatterFromMd(raw);

      let finalBody = body;
      const quickrefPath = path.join(skillDir, "QUICKREF.md");
      let quickref: string | undefined;
      if (fs.existsSync(quickrefPath)) {
        quickref = fs.readFileSync(quickrefPath, "utf-8");
        finalBody = `${body}\n\n---\n\n## Quick Reference\n\n${quickref}`;
      }

      skills.push({
        name: frontmatter.name ?? entry,
        description: frontmatter.description ?? "",
        body: finalBody,
        quickref,
      });
    }
  }

  // Read commands
  const commands: KnowledgeWorkSkill[] = [];
  const commandsDir = path.join(pluginDir, "commands");
  if (fs.existsSync(commandsDir)) {
    for (const entry of fs.readdirSync(commandsDir)) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const cmdPath = path.join(commandsDir, entry);
      const raw = fs.readFileSync(cmdPath, "utf-8");
      const { frontmatter, body } = parseFrontmatterFromMd(raw);
      const name = frontmatter.name ?? entry.replace(/\.md$/, "");
      commands.push({
        name,
        description: frontmatter.description ?? "",
        body,
      });
    }
  }

  return {
    name: pluginJson.name,
    description: pluginJson.description ?? "",
    skills,
    commands,
    mcpServers,
  };
}

// ─── Part 4: Full Conversion ──────────────────────────────────────

export function convertPlugin(opts: {
  inputDir: string;
  outputDir: string;
  prefix: string;
  emoji: string;
  dryRun?: boolean;
}): ConversionResult {
  const { inputDir, outputDir, prefix, emoji, dryRun = false } = opts;
  const plugin = readKnowledgeWorkPlugin(inputDir);

  const skillsWritten: string[] = [];
  const commandsWritten: string[] = [];
  const connectorMappings: Record<string, { backend: string; ref: string }> = {};
  const warnings: string[] = [];

  // Extract connector mappings
  for (const [serverName, serverConfig] of Object.entries(plugin.mcpServers)) {
    const category = mapMcpServerToCategory(serverName);
    if (category) {
      connectorMappings[serverName] = {
        backend: category,
        ref: serverConfig.url,
      };
    } else {
      warnings.push(`No category mapping for MCP server "${serverName}" (${serverConfig.url})`);
    }
  }

  // Convert skills
  for (const skill of plugin.skills) {
    const fm = transformFrontmatter(skill, prefix, emoji);
    const bodyTransform = transformKnowledgeWorkBody(skill.body, fm.name);
    const md = renderOpenClawSkillMd(fm, bodyTransform.body);
    if (!dryRun) {
      const outDir = path.join(outputDir, fm.name);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "SKILL.md"), md);
    }
    skillsWritten.push(fm.name);
    warnings.push(...bodyTransform.warnings);
  }

  // Convert commands
  for (const cmd of plugin.commands) {
    const fm = transformFrontmatter(cmd, prefix, emoji);
    const bodyTransform = transformKnowledgeWorkBody(cmd.body, fm.name);
    const md = renderOpenClawSkillMd(fm, bodyTransform.body);
    if (!dryRun) {
      const outDir = path.join(outputDir, fm.name);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "SKILL.md"), md);
    }
    commandsWritten.push(fm.name);
    warnings.push(...bodyTransform.warnings);
  }

  return { skillsWritten, commandsWritten, connectorMappings, warnings };
}

// ─── CLI Entry Point ──────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        args[key] = value;
        i++;
      }
    }
  }
  return args;
}

// Only run CLI when executed directly
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].includes("convert-knowledge-work");

if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = args.input;
  const prefix = args.prefix;
  const outputDir = args.output ?? "skills";
  const emoji = args.emoji ?? "💼";

  if (!inputDir || !prefix) {
    console.error("Usage: --input <dir> --prefix <prefix> [--output <dir>] [--emoji <emoji>]");
    process.exit(1);
  }

  const result = convertPlugin({ inputDir, outputDir, prefix, emoji });

  console.log(`\nConversion complete:`);
  console.log(`  Skills written: ${result.skillsWritten.length}`);
  for (const s of result.skillsWritten) {
    console.log(`    - ${s}`);
  }
  console.log(`  Commands written: ${result.commandsWritten.length}`);
  for (const c of result.commandsWritten) {
    console.log(`    - ${c}`);
  }
  console.log(`  Connector mappings: ${Object.keys(result.connectorMappings).length}`);
  for (const [name, mapping] of Object.entries(result.connectorMappings)) {
    console.log(`    - ${name} → ${mapping.backend} (${mapping.ref})`);
  }
  if (result.warnings.length > 0) {
    console.log(`  Warnings:`);
    for (const w of result.warnings) {
      console.log(`    ⚠ ${w}`);
    }
  }
}
