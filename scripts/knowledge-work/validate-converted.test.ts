import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateConvertedSkills } from "./validate-converted.js";

function writeConnectors(connectorsPath: string, keys: string[]): void {
  const connectors = Object.fromEntries(
    keys.map((key) => [key, { backend: "mock", ref: `${key}-ref` }]),
  );
  fs.mkdirSync(path.dirname(connectorsPath), { recursive: true });
  fs.writeFileSync(connectorsPath, JSON.stringify({ connectors }, null, 2));
}

function writeSkill(skillsDir: string, skillName: string, body: string): void {
  const dir = path.join(skillsDir, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
}

describe("validateConvertedSkills", () => {
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

  function createFixture(): { rootDir: string; skillsDir: string; connectorsPath: string } {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-converted-"));
    tempDirs.push(rootDir);
    return {
      rootDir,
      skillsDir: path.join(rootDir, "skills"),
      connectorsPath: path.join(rootDir, "extensions", "work-connectors", "connectors.json"),
    };
  }

  it("fails when a stale CONNECTORS.md reference remains", () => {
    const { skillsDir, connectorsPath } = createFixture();
    writeConnectors(connectorsPath, ["~~crm"]);
    writeSkill(skillsDir, "sales-stale", "# Skill\n\nSee CONNECTORS.md.\nUse ~~crm.");

    const result = validateConvertedSkills({
      skillsDir,
      prefixes: ["sales"],
      connectorsPath,
    });

    expect(result.violations.some((violation) => violation.includes("CONNECTORS.md"))).toBe(true);
  });

  it("fails on non-canonical placeholder aliases", () => {
    const { skillsDir, connectorsPath } = createFixture();
    writeConnectors(connectorsPath, ["~~crm", "~~analytics"]);
    writeSkill(skillsDir, "sales-alias", "# Skill\n\nUse ~~CRM and ~~product analytics.");

    const result = validateConvertedSkills({
      skillsDir,
      prefixes: ["sales"],
      connectorsPath,
    });

    expect(result.violations.some((violation) => violation.includes("non-canonical"))).toBe(true);
  });

  it("fails when canonical placeholders are missing from connectors map", () => {
    const { skillsDir, connectorsPath } = createFixture();
    writeConnectors(connectorsPath, ["~~crm"]);
    writeSkill(skillsDir, "sales-missing", "# Skill\n\nUse ~~crm and ~~chat.");

    const result = validateConvertedSkills({
      skillsDir,
      prefixes: ["sales"],
      connectorsPath,
    });

    expect(result.violations).toContain(
      "sales-missing: placeholder ~~chat missing from connectors map",
    );
  });

  it("passes for valid converted skills and honors prefix filtering", () => {
    const { skillsDir, connectorsPath } = createFixture();
    writeConnectors(connectorsPath, ["~~crm", "~~chat"]);
    writeSkill(skillsDir, "sales-good", "# Skill\n\nUse ~~crm and ~~chat.");
    writeSkill(skillsDir, "marketing-ignored", "# Skill\n\nSee CONNECTORS.md and use ~~BAD.");

    const result = validateConvertedSkills({
      skillsDir,
      prefixes: ["sales"],
      connectorsPath,
    });

    expect(result.violations).toEqual([]);
    expect(result.scannedSkills).toBe(1);
    expect(result.scannedFiles).toBe(1);
  });
});
