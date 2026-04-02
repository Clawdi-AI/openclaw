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

  it("includes pptx toolchain under powerpoint-pptx", () => {
    const skillsDir = resolveBundledSkillsDir({ cwd: process.cwd() });
    expect(skillsDir).toBeTruthy();

    const root = skillsDir as string;
    mustExist(root, "powerpoint-pptx/SKILL.md");
    mustExist(root, "powerpoint-pptx/editing.md");
    mustExist(root, "powerpoint-pptx/pptxgenjs.md");
    mustExist(root, "powerpoint-pptx/scripts/thumbnail.py");
    mustExist(root, "powerpoint-pptx/scripts/office/validate.py");
  });

  it("includes xlsx office toolchain under excel-xlsx", () => {
    const skillsDir = resolveBundledSkillsDir({ cwd: process.cwd() });
    expect(skillsDir).toBeTruthy();

    const root = skillsDir as string;
    mustExist(root, "excel-xlsx/SKILL.md");
    mustExist(root, "excel-xlsx/scripts/recalc.py");
    mustExist(root, "excel-xlsx/scripts/office/validate.py");
  });

  it("includes canvas-design font assets under canvas-design", () => {
    const skillsDir = resolveBundledSkillsDir({ cwd: process.cwd() });
    expect(skillsDir).toBeTruthy();

    const root = skillsDir as string;
    mustExist(root, "canvas-design/SKILL.md");
    mustExist(root, "canvas-design/LICENSE.txt");
    mustExist(root, "canvas-design/canvas-fonts/ArsenalSC-Regular.ttf");
    mustExist(root, "canvas-design/canvas-fonts/WorkSans-Regular.ttf");
  });
});
