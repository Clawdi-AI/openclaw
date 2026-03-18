import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importKnowledgeWorkFromManifest } from "./import-knowledge-work.js";

function writePluginFixture(opts: {
  rootDir: string;
  pluginName: string;
  skillName: string;
  commandName: string;
}): void {
  const pluginDir = path.join(opts.rootDir, opts.pluginName);
  fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: opts.pluginName,
      description: `${opts.pluginName} plugin`,
    }),
  );

  fs.mkdirSync(path.join(pluginDir, "skills", opts.skillName), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "skills", opts.skillName, "SKILL.md"),
    `---\nname: ${opts.skillName}\ndescription: ${opts.skillName} skill\n---\n# ${opts.skillName}\n\nUse ~~crm.`,
  );

  fs.mkdirSync(path.join(pluginDir, "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "commands", `${opts.commandName}.md`),
    `---\nname: ${opts.commandName}\ndescription: ${opts.commandName} command\n---\n# ${opts.commandName}\n\nCommand body.`,
  );
}

describe("importKnowledgeWorkFromManifest", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) {
        continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createFixture(): {
    rootDir: string;
    upstreamDir: string;
    outputDir: string;
    manifestPath: string;
  } {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-knowledge-work-"));
    tempDirs.push(rootDir);

    const upstreamDir = path.join(rootDir, "upstream");
    const outputDir = path.join(rootDir, "skills-out");
    const manifestDir = path.join(rootDir, "manifest");
    fs.mkdirSync(upstreamDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });

    return {
      rootDir,
      upstreamDir,
      outputDir,
      manifestPath: path.join(manifestDir, "import-manifest.json"),
    };
  }

  it("reads manifest entries and converts only enabled plugins", () => {
    const { upstreamDir, outputDir, manifestPath } = createFixture();
    writePluginFixture({
      rootDir: upstreamDir,
      pluginName: "sales",
      skillName: "account-research",
      commandName: "daily-brief",
    });
    writePluginFixture({
      rootDir: upstreamDir,
      pluginName: "marketing",
      skillName: "campaign-plan",
      commandName: "email-sequence",
    });

    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          plugins: [
            {
              sourceDir: "../upstream/sales",
              prefix: "sales",
              emoji: "💼",
              enabled: true,
            },
            {
              sourceDir: "../upstream/marketing",
              prefix: "marketing",
              emoji: "📣",
              enabled: false,
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = importKnowledgeWorkFromManifest({
      manifestPath,
      outputDir,
      onlyPrefixes: [],
      dryRun: false,
    });

    expect(result.pluginsProcessed).toBe(1);
    expect(result.pluginsSkipped).toBe(1);
    expect(result.skillsWritten).toBe(1);
    expect(result.commandsWritten).toBe(1);
    expect(fs.existsSync(path.join(outputDir, "sales-account-research", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "marketing-campaign-plan", "SKILL.md"))).toBe(false);
  });

  it("supports --only prefix filtering", () => {
    const { upstreamDir, outputDir, manifestPath } = createFixture();
    writePluginFixture({
      rootDir: upstreamDir,
      pluginName: "sales",
      skillName: "account-research",
      commandName: "daily-brief",
    });
    writePluginFixture({
      rootDir: upstreamDir,
      pluginName: "marketing",
      skillName: "campaign-plan",
      commandName: "email-sequence",
    });

    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          plugins: [
            {
              sourceDir: "../upstream/sales",
              prefix: "sales",
              emoji: "💼",
              enabled: true,
            },
            {
              sourceDir: "../upstream/marketing",
              prefix: "marketing",
              emoji: "📣",
              enabled: true,
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = importKnowledgeWorkFromManifest({
      manifestPath,
      outputDir,
      onlyPrefixes: ["marketing"],
      dryRun: false,
    });

    expect(result.pluginsProcessed).toBe(1);
    expect(result.pluginsSkipped).toBe(1);
    expect(fs.existsSync(path.join(outputDir, "marketing-campaign-plan", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "sales-account-research", "SKILL.md"))).toBe(false);
  });

  it("supports dry-run without writing files", () => {
    const { upstreamDir, outputDir, manifestPath } = createFixture();
    writePluginFixture({
      rootDir: upstreamDir,
      pluginName: "sales",
      skillName: "account-research",
      commandName: "daily-brief",
    });

    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          plugins: [
            {
              sourceDir: "../upstream/sales",
              prefix: "sales",
              emoji: "💼",
              enabled: true,
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = importKnowledgeWorkFromManifest({
      manifestPath,
      outputDir,
      onlyPrefixes: [],
      dryRun: true,
    });

    expect(result.pluginsProcessed).toBe(1);
    expect(result.skillsWritten).toBe(1);
    expect(result.commandsWritten).toBe(1);
    expect(fs.existsSync(path.join(outputDir, "sales-account-research", "SKILL.md"))).toBe(false);
  });
});
