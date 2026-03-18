import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  transformFrontmatter,
  parseFrontmatterFromMd,
  renderOpenClawSkillMd,
  mapMcpServerToCategory,
  readKnowledgeWorkPlugin,
  convertPlugin,
  type KnowledgeWorkSkill,
} from "./convert-knowledge-work.js";

// ─── Part 1: Frontmatter Transformation ───────────────────────────

describe("transformFrontmatter", () => {
  it("prefixes skill name with the given prefix", () => {
    const skill: KnowledgeWorkSkill = {
      name: "account-research",
      description: "Research a company.",
      body: "# Account Research",
    };
    const result = transformFrontmatter(skill, "sales", "💼");
    expect(result.name).toBe("sales-account-research");
  });

  it("strips ~~ from description", () => {
    const skill: KnowledgeWorkSkill = {
      name: "foo",
      description: "Uses ~~crm and ~~chat tools",
      body: "",
    };
    const result = transformFrontmatter(skill, "work", "💼");
    expect(result.description).toBe("Uses crm and chat tools");
  });

  it("generates metadata JSON string with emoji", () => {
    const skill: KnowledgeWorkSkill = {
      name: "bar",
      description: "desc",
      body: "",
    };
    const result = transformFrontmatter(skill, "work", "🔧");
    const meta = JSON.parse(result.metadata);
    expect(meta.openclaw).toBeDefined();
    expect(meta.openclaw.emoji).toBe("🔧");
  });

  it("handles description with no ~~ markers", () => {
    const skill: KnowledgeWorkSkill = {
      name: "plain",
      description: "A simple description",
      body: "",
    };
    const result = transformFrontmatter(skill, "x", "💼");
    expect(result.description).toBe("A simple description");
  });
});

describe("parseFrontmatterFromMd", () => {
  it("parses standard YAML frontmatter", () => {
    const content = `---\nname: foo\ndescription: bar\n---\n# Body`;
    const result = parseFrontmatterFromMd(content);
    expect(result.frontmatter.name).toBe("foo");
    expect(result.frontmatter.description).toBe("bar");
    expect(result.body).toBe("# Body");
  });

  it("returns empty frontmatter when no --- delimiters", () => {
    const content = "# Just a body";
    const result = parseFrontmatterFromMd(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("# Just a body");
  });

  it("handles multiline description (long single line in YAML)", () => {
    const content = `---\nname: test\ndescription: A very long description that continues on the same line.\n---\nBody text`;
    const result = parseFrontmatterFromMd(content);
    expect(result.frontmatter.description).toBe(
      "A very long description that continues on the same line.",
    );
  });

  it("handles quoted values in frontmatter", () => {
    const content = `---\nname: "my-skill"\ndescription: "A skill with: colons"\n---\nBody`;
    const result = parseFrontmatterFromMd(content);
    expect(result.frontmatter.name).toBe("my-skill");
    expect(result.frontmatter.description).toBe("A skill with: colons");
  });
});

describe("renderOpenClawSkillMd", () => {
  it("renders full SKILL.md with frontmatter and body", () => {
    const fm = {
      name: "sales-account-research",
      description: "Research a company.",
      metadata: '{"openclaw":{"emoji":"💼"}}',
    };
    const body = "# Account Research\n\nSome content.";
    const result = renderOpenClawSkillMd(fm, body);
    expect(result).toContain("---\n");
    expect(result).toContain("name: sales-account-research\n");
    expect(result).toContain("description: Research a company.\n");
    expect(result).toContain("metadata:");
    expect(result).toContain("# Account Research");
    // Should have frontmatter delimiters
    const parts = result.split("---");
    expect(parts.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Part 2: MCP Server Mapping ───────────────────────────────────

describe("mapMcpServerToCategory", () => {
  const expectedMappings: Array<[string, string]> = [
    ["hubspot", "~~crm"],
    ["close", "~~crm"],
    ["salesforce", "~~crm"],
    ["slack", "~~chat"],
    ["ms365", "~~email"],
    ["gmail", "~~email"],
    ["notion", "~~docs"],
    ["atlassian", "~~docs"],
    ["guru", "~~docs"],
    ["zoominfo", "~~enrichment"],
    ["apollo", "~~enrichment"],
    ["clay", "~~enrichment"],
    ["linear", "~~tracker"],
    ["asana", "~~tracker"],
    ["monday", "~~tracker"],
    ["clickup", "~~tracker"],
    ["google-calendar", "~~calendar"],
    ["amplitude", "~~analytics"],
    ["similarweb", "~~analytics"],
    ["pendo", "~~analytics"],
    ["figma", "~~design"],
    ["canva", "~~design"],
    ["fireflies", "~~calls"],
    ["outreach", "~~outreach"],
    ["ahrefs", "~~seo"],
    ["klaviyo", "~~email-marketing"],
  ];

  for (const [server, category] of expectedMappings) {
    it(`maps "${server}" to "${category}"`, () => {
      expect(mapMcpServerToCategory(server)).toBe(category);
    });
  }

  it("returns null for unknown servers", () => {
    expect(mapMcpServerToCategory("unknown-server")).toBeNull();
    expect(mapMcpServerToCategory("intercom")).toBeNull();
    expect(mapMcpServerToCategory("zendesk")).toBeNull();
  });
});

// ─── Part 3: Plugin Reader ────────────────────────────────────────

describe("readKnowledgeWorkPlugin", () => {
  const salesDir = "/Users/hashwarlock/Projects/Clawdi/knowledge-work-plugins/sales";
  const salesExists = fs.existsSync(salesDir);

  it.skipIf(!salesExists)("reads the sales plugin metadata", () => {
    const plugin = readKnowledgeWorkPlugin(salesDir);
    expect(plugin.name).toBe("sales");
    expect(plugin.description).toBeTruthy();
  });

  it.skipIf(!salesExists)("reads skills including account-research", () => {
    const plugin = readKnowledgeWorkPlugin(salesDir);
    const names = plugin.skills.map((s) => s.name);
    expect(names).toContain("account-research");
    expect(plugin.skills.length).toBeGreaterThan(0);
  });

  it.skipIf(!salesExists)("reads mcpServers from .mcp.json", () => {
    const plugin = readKnowledgeWorkPlugin(salesDir);
    expect(Object.keys(plugin.mcpServers).length).toBeGreaterThan(0);
    expect(plugin.mcpServers.hubspot).toBeDefined();
  });

  it.skipIf(!salesExists)("skill body is populated", () => {
    const plugin = readKnowledgeWorkPlugin(salesDir);
    const ar = plugin.skills.find((s) => s.name === "account-research");
    expect(ar).toBeDefined();
    expect(ar!.body.length).toBeGreaterThan(0);
  });
});

// ─── Part 4: Full Conversion + CLI ────────────────────────────────

describe("convertPlugin", () => {
  let tmpDir: string;
  let inputDir: string;
  let outputDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "convert-kw-test-"));
    inputDir = path.join(tmpDir, "my-plugin");
    outputDir = path.join(tmpDir, "output");

    // Create synthetic plugin structure
    fs.mkdirSync(path.join(inputDir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(inputDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "test-plugin",
        description: "A test plugin",
      }),
    );
    fs.writeFileSync(
      path.join(inputDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          hubspot: { type: "http", url: "https://mcp.hubspot.com/anthropic" },
          slack: { type: "http", url: "https://mcp.slack.com/mcp" },
          "unknown-thing": { type: "http", url: "https://example.com/mcp" },
        },
      }),
    );

    // Create a skill
    const skillDir = path.join(inputDir, "skills", "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: my-skill\ndescription: Does ~~crm things with ~~chat.\n---\n# My Skill\n\nBody content here.`,
    );

    // Create a skill that exercises placeholder normalization and stale note stripping.
    const placeholderSkillDir = path.join(inputDir, "skills", "placeholder-skill");
    fs.mkdirSync(placeholderSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(placeholderSkillDir, "SKILL.md"),
      `---\nname: placeholder-skill\ndescription: Has placeholder variants.\n---\n# Placeholder Skill\n\nIf you see unfamiliar placeholders in source docs, see CONNECTORS.md.\nUse ~~CRM and ~~product analytics. Also watch ~~mystery.`,
    );

    // Create a skill with QUICKREF.md
    const skill2Dir = path.join(inputDir, "skills", "other-skill");
    fs.mkdirSync(skill2Dir, { recursive: true });
    fs.writeFileSync(
      path.join(skill2Dir, "SKILL.md"),
      `---\nname: other-skill\ndescription: Another skill.\n---\n# Other Skill`,
    );
    fs.writeFileSync(path.join(skill2Dir, "QUICKREF.md"), "Quick reference content here.");

    // Create a command
    const cmdDir = path.join(inputDir, "commands");
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(
      path.join(cmdDir, "do-thing.md"),
      `---\nname: do-thing\ndescription: Does a thing.\n---\n# Do Thing\n\nCommand body.`,
    );
    fs.writeFileSync(
      path.join(cmdDir, "do-placeholder.md"),
      `---\nname: do-placeholder\ndescription: Uses placeholder variants.\n---\n# Do Placeholder\n\nIf you see unfamiliar placeholders in source docs, see CONNECTORS.md.\nRun with ~~CRM and ~~mystery.`,
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes converted skill files to the output directory", () => {
    const result = convertPlugin({
      inputDir,
      outputDir,
      prefix: "tp",
      emoji: "🔧",
    });
    expect(result.skillsWritten).toContain("tp-my-skill");
    expect(result.skillsWritten).toContain("tp-other-skill");

    const skillPath = path.join(outputDir, "tp-my-skill", "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);

    const content = fs.readFileSync(skillPath, "utf-8");
    expect(content).toContain("name: tp-my-skill");
    expect(content).toContain("Does crm things with chat.");
  });

  it("strips stale connector notes, normalizes placeholders, and warns on unresolved placeholders", () => {
    const result = convertPlugin({
      inputDir,
      outputDir,
      prefix: "tp",
      emoji: "🔧",
    });

    const content = fs.readFileSync(
      path.join(outputDir, "tp-placeholder-skill", "SKILL.md"),
      "utf-8",
    );
    expect(content).not.toContain("If you see unfamiliar placeholders");
    expect(content).not.toContain("CONNECTORS.md");
    expect(content).toContain("Use ~~crm and ~~analytics. Also watch ~~mystery.");
    expect(result.warnings).toContain("Unresolved placeholder in tp-placeholder-skill: ~~mystery");
  });

  it("folds QUICKREF.md into the skill body", () => {
    convertPlugin({ inputDir, outputDir, prefix: "tp", emoji: "🔧" });

    const content = fs.readFileSync(path.join(outputDir, "tp-other-skill", "SKILL.md"), "utf-8");
    expect(content).toContain("## Quick Reference");
    expect(content).toContain("Quick reference content here.");
  });

  it("writes converted command files", () => {
    const result = convertPlugin({
      inputDir,
      outputDir,
      prefix: "tp",
      emoji: "🔧",
    });
    expect(result.commandsWritten).toContain("tp-do-thing");
    expect(result.commandsWritten).toContain("tp-do-placeholder");
  });

  it("strips stale connector notes and normalizes placeholders in command bodies", () => {
    const result = convertPlugin({
      inputDir,
      outputDir,
      prefix: "tp",
      emoji: "🔧",
    });

    const content = fs.readFileSync(path.join(outputDir, "tp-do-placeholder", "SKILL.md"), "utf-8");
    expect(content).not.toContain("If you see unfamiliar placeholders");
    expect(content).not.toContain("CONNECTORS.md");
    expect(content).toContain("Run with ~~crm and ~~mystery.");
    expect(result.warnings).toContain("Unresolved placeholder in tp-do-placeholder: ~~mystery");
  });

  it("extracts connector mappings from MCP servers", () => {
    const result = convertPlugin({
      inputDir,
      outputDir,
      prefix: "tp",
      emoji: "🔧",
    });
    expect(result.connectorMappings.hubspot).toBeDefined();
    expect(result.connectorMappings.hubspot.backend).toBe("~~crm");
    expect(result.connectorMappings.hubspot.ref).toBe("https://mcp.hubspot.com/anthropic");
    expect(result.connectorMappings.slack.backend).toBe("~~chat");
  });

  it("adds warnings for unmapped MCP servers", () => {
    const result = convertPlugin({
      inputDir,
      outputDir,
      prefix: "tp",
      emoji: "🔧",
    });
    expect(result.warnings.some((w) => w.includes("unknown-thing"))).toBe(true);
  });
});
