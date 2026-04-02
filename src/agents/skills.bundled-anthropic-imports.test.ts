import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledSkillsDir } from "./skills/bundled-dir.js";

function mustExist(root: string, rel: string): void {
  expect(fs.existsSync(path.join(root, rel))).toBe(true);
}

describe("bundled Anthropic skill imports", () => {
  it("includes bundled pdf skill files", () => {
    const skillsDir = resolveBundledSkillsDir({ cwd: process.cwd() });
    expect(skillsDir).toBeTruthy();

    const root = skillsDir as string;
    mustExist(root, "pdf/SKILL.md");
    mustExist(root, "pdf/reference.md");
    mustExist(root, "pdf/forms.md");
    mustExist(root, "pdf/scripts/fill_fillable_fields.py");
  });

  it("includes docx office toolchain under word-docx", () => {
    const skillsDir = resolveBundledSkillsDir({ cwd: process.cwd() });
    expect(skillsDir).toBeTruthy();

    const root = skillsDir as string;
    mustExist(root, "word-docx/SKILL.md");
    mustExist(root, "word-docx/scripts/accept_changes.py");
    mustExist(root, "word-docx/scripts/comment.py");
    mustExist(root, "word-docx/scripts/office/validate.py");
    mustExist(root, "word-docx/scripts/templates/comments.xml");
  });
});
