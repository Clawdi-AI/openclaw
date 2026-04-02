# Anthropic Skills Tooling Import for OpenClaw Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import Anthropic `canvas-design`, `docx`, `pdf`, `pptx`, and `xlsx` skill content/tooling into OpenClaw while preserving existing OpenClaw Office skill slugs and keeping `pdf-extract` intact.

**Architecture:** Use a parity-first vendor strategy. Add/update skill-local assets and scripts directly under existing OpenClaw skill directories (`skills/canvas`, `skills/word-docx`, `skills/powerpoint-pptx`, `skills/excel-xlsx`) and add a new `skills/pdf`. Add regression tests that assert bundled-skill file presence and frontmatter parseability. Normalize SKILL frontmatter to OpenClaw-compatible metadata and dependency declarations.

**Tech Stack:** TypeScript + Vitest (skills regression tests), Markdown frontmatter, shell/rsync for vendoring files, Python tool scripts (vendored), OpenClaw CLI (`openclaw skills`).

---

## Planned File Structure

### Create

- `skills/pdf/SKILL.md`
- `skills/pdf/LICENSE.txt`
- `skills/pdf/forms.md`
- `skills/pdf/reference.md`
- `skills/pdf/scripts/check_bounding_boxes.py`
- `skills/pdf/scripts/check_fillable_fields.py`
- `skills/pdf/scripts/convert_pdf_to_images.py`
- `skills/pdf/scripts/create_validation_image.py`
- `skills/pdf/scripts/extract_form_field_info.py`
- `skills/pdf/scripts/extract_form_structure.py`
- `skills/pdf/scripts/fill_fillable_fields.py`
- `skills/pdf/scripts/fill_pdf_form_with_annotations.py`
- `skills/word-docx/LICENSE.txt`
- `skills/word-docx/scripts/**` (from upstream `skills/docx/scripts/**`)
- `skills/powerpoint-pptx/LICENSE.txt`
- `skills/powerpoint-pptx/editing.md`
- `skills/powerpoint-pptx/pptxgenjs.md`
- `skills/powerpoint-pptx/scripts/**` (from upstream `skills/pptx/scripts/**`)
- `skills/excel-xlsx/LICENSE.txt`
- `skills/excel-xlsx/scripts/**` (from upstream `skills/xlsx/scripts/**`)
- `skills/canvas/LICENSE.txt`
- `skills/canvas/canvas-fonts/**`
- `src/agents/skills.bundled-anthropic-imports.test.ts`

### Modify

- `skills/canvas/SKILL.md`
- `skills/word-docx/SKILL.md`
- `skills/powerpoint-pptx/SKILL.md`
- `skills/excel-xlsx/SKILL.md`
- `docs/tools/skills.md`
- `docs/cli/skills.md`

### Preserve unchanged

- `skills/pdf-extract/SKILL.md`
- `skills/word-docx/_meta.json`
- `skills/word-docx/.clawhub/origin.json`
- `skills/powerpoint-pptx/_meta.json`
- `skills/powerpoint-pptx/.clawhub/origin.json`
- `skills/excel-xlsx/_meta.json`
- `skills/excel-xlsx/.clawhub/origin.json`

---

### Task 1: Lock Upstream Source and Add PDF Failing Test

**Files:**

- Modify: `src/agents/skills.bundled-anthropic-imports.test.ts`
- Test: `src/agents/skills.bundled-anthropic-imports.test.ts`

- [ ] **Step 1: Write the failing test for new `skills/pdf` bundle presence**

```ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledSkillsDir } from "./skills/bundled-dir.js";

function mustExist(root: string, rel: string) {
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
});
```

- [ ] **Step 2: Run test to verify it fails (pdf skill not present yet)**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts -t "includes bundled pdf skill files"
```

Expected: FAIL with missing `skills/pdf/*` paths.

- [ ] **Step 3: Lock Anthropic source snapshot and vendor PDF skill files**

Run:

```bash
mkdir -p /tmp/anthropic-skills
if [ ! -d /tmp/anthropic-skills/.git ]; then
  git clone --depth 1 https://github.com/anthropics/skills /tmp/anthropic-skills
fi

git -C /tmp/anthropic-skills rev-parse HEAD

mkdir -p skills/pdf/scripts
cp /tmp/anthropic-skills/skills/pdf/SKILL.md skills/pdf/SKILL.md
cp /tmp/anthropic-skills/skills/pdf/LICENSE.txt skills/pdf/LICENSE.txt
cp /tmp/anthropic-skills/skills/pdf/forms.md skills/pdf/forms.md
cp /tmp/anthropic-skills/skills/pdf/reference.md skills/pdf/reference.md
rsync -a /tmp/anthropic-skills/skills/pdf/scripts/ skills/pdf/scripts/
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts -t "includes bundled pdf skill files"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
scripts/committer "skills: add bundled pdf skill from anthropic source" \
  src/agents/skills.bundled-anthropic-imports.test.ts \
  skills/pdf/SKILL.md skills/pdf/LICENSE.txt skills/pdf/forms.md skills/pdf/reference.md \
  skills/pdf/scripts/check_bounding_boxes.py \
  skills/pdf/scripts/check_fillable_fields.py \
  skills/pdf/scripts/convert_pdf_to_images.py \
  skills/pdf/scripts/create_validation_image.py \
  skills/pdf/scripts/extract_form_field_info.py \
  skills/pdf/scripts/extract_form_structure.py \
  skills/pdf/scripts/fill_fillable_fields.py \
  skills/pdf/scripts/fill_pdf_form_with_annotations.py
```

---

### Task 2: Import DOCX Toolchain into `skills/word-docx`

**Files:**

- Modify: `src/agents/skills.bundled-anthropic-imports.test.ts`
- Modify/Create: `skills/word-docx/SKILL.md`, `skills/word-docx/LICENSE.txt`, `skills/word-docx/scripts/**`
- Test: `src/agents/skills.bundled-anthropic-imports.test.ts`

- [ ] **Step 1: Extend test with failing DOCX assertions**

```ts
it("includes docx office toolchain under word-docx", () => {
  const skillsDir = resolveBundledSkillsDir({ cwd: process.cwd() });
  const root = skillsDir as string;

  mustExist(root, "word-docx/SKILL.md");
  mustExist(root, "word-docx/scripts/accept_changes.py");
  mustExist(root, "word-docx/scripts/comment.py");
  mustExist(root, "word-docx/scripts/office/validate.py");
  mustExist(root, "word-docx/scripts/templates/comments.xml");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts -t "includes docx office toolchain under word-docx"
```

Expected: FAIL on missing `word-docx/scripts/*` files.

- [ ] **Step 3: Vendor DOCX scripts and upstream license; map SKILL to `word-docx`**

Run:

```bash
mkdir -p skills/word-docx/scripts
cp /tmp/anthropic-skills/skills/docx/LICENSE.txt skills/word-docx/LICENSE.txt
cp /tmp/anthropic-skills/skills/docx/SKILL.md skills/word-docx/SKILL.md
rsync -a /tmp/anthropic-skills/skills/docx/scripts/ skills/word-docx/scripts/
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts -t "includes docx office toolchain under word-docx"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
scripts/committer "skills: import docx office tooling into word-docx" \
  src/agents/skills.bundled-anthropic-imports.test.ts \
  skills/word-docx/SKILL.md skills/word-docx/LICENSE.txt skills/word-docx/scripts
```

---

### Task 3: Import PPTX Toolchain into `skills/powerpoint-pptx`

**Files:**

- Modify: `src/agents/skills.bundled-anthropic-imports.test.ts`
- Modify/Create: `skills/powerpoint-pptx/SKILL.md`, `skills/powerpoint-pptx/LICENSE.txt`, `skills/powerpoint-pptx/editing.md`, `skills/powerpoint-pptx/pptxgenjs.md`, `skills/powerpoint-pptx/scripts/**`
- Test: `src/agents/skills.bundled-anthropic-imports.test.ts`

- [ ] **Step 1: Extend test with failing PPTX assertions**

```ts
it("includes pptx toolchain under powerpoint-pptx", () => {
  const skillsDir = resolveBundledSkillsDir({ cwd: process.cwd() });
  const root = skillsDir as string;

  mustExist(root, "powerpoint-pptx/SKILL.md");
  mustExist(root, "powerpoint-pptx/editing.md");
  mustExist(root, "powerpoint-pptx/pptxgenjs.md");
  mustExist(root, "powerpoint-pptx/scripts/thumbnail.py");
  mustExist(root, "powerpoint-pptx/scripts/office/validate.py");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts -t "includes pptx toolchain under powerpoint-pptx"
```

Expected: FAIL on missing references/scripts.

- [ ] **Step 3: Vendor PPTX references and scripts**

Run:

```bash
mkdir -p skills/powerpoint-pptx/scripts
cp /tmp/anthropic-skills/skills/pptx/LICENSE.txt skills/powerpoint-pptx/LICENSE.txt
cp /tmp/anthropic-skills/skills/pptx/SKILL.md skills/powerpoint-pptx/SKILL.md
cp /tmp/anthropic-skills/skills/pptx/editing.md skills/powerpoint-pptx/editing.md
cp /tmp/anthropic-skills/skills/pptx/pptxgenjs.md skills/powerpoint-pptx/pptxgenjs.md
rsync -a /tmp/anthropic-skills/skills/pptx/scripts/ skills/powerpoint-pptx/scripts/
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts -t "includes pptx toolchain under powerpoint-pptx"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
scripts/committer "skills: import pptx tooling into powerpoint-pptx" \
  src/agents/skills.bundled-anthropic-imports.test.ts \
  skills/powerpoint-pptx/SKILL.md skills/powerpoint-pptx/LICENSE.txt \
  skills/powerpoint-pptx/editing.md skills/powerpoint-pptx/pptxgenjs.md \
  skills/powerpoint-pptx/scripts
```

---

### Task 4: Import XLSX Toolchain into `skills/excel-xlsx`

**Files:**

- Modify: `src/agents/skills.bundled-anthropic-imports.test.ts`
- Modify/Create: `skills/excel-xlsx/SKILL.md`, `skills/excel-xlsx/LICENSE.txt`, `skills/excel-xlsx/scripts/**`
- Test: `src/agents/skills.bundled-anthropic-imports.test.ts`

- [ ] **Step 1: Extend test with failing XLSX assertions**

```ts
it("includes xlsx office toolchain under excel-xlsx", () => {
  const skillsDir = resolveBundledSkillsDir({ cwd: process.cwd() });
  const root = skillsDir as string;

  mustExist(root, "excel-xlsx/SKILL.md");
  mustExist(root, "excel-xlsx/scripts/recalc.py");
  mustExist(root, "excel-xlsx/scripts/office/validate.py");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts -t "includes xlsx office toolchain under excel-xlsx"
```

Expected: FAIL on missing scripts.

- [ ] **Step 3: Vendor XLSX scripts and upstream SKILL/license**

Run:

```bash
mkdir -p skills/excel-xlsx/scripts
cp /tmp/anthropic-skills/skills/xlsx/LICENSE.txt skills/excel-xlsx/LICENSE.txt
cp /tmp/anthropic-skills/skills/xlsx/SKILL.md skills/excel-xlsx/SKILL.md
rsync -a /tmp/anthropic-skills/skills/xlsx/scripts/ skills/excel-xlsx/scripts/
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts -t "includes xlsx office toolchain under excel-xlsx"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
scripts/committer "skills: import xlsx tooling into excel-xlsx" \
  src/agents/skills.bundled-anthropic-imports.test.ts \
  skills/excel-xlsx/SKILL.md skills/excel-xlsx/LICENSE.txt skills/excel-xlsx/scripts
```

---

### Task 5: Import Canvas Design Assets into `skills/canvas`

**Files:**

- Modify: `src/agents/skills.bundled-anthropic-imports.test.ts`
- Modify/Create: `skills/canvas/SKILL.md`, `skills/canvas/LICENSE.txt`, `skills/canvas/canvas-fonts/**`
- Test: `src/agents/skills.bundled-anthropic-imports.test.ts`

- [ ] **Step 1: Extend test with failing canvas asset assertions**

```ts
it("includes canvas-design font assets under canvas", () => {
  const skillsDir = resolveBundledSkillsDir({ cwd: process.cwd() });
  const root = skillsDir as string;

  mustExist(root, "canvas/SKILL.md");
  mustExist(root, "canvas/LICENSE.txt");
  mustExist(root, "canvas/canvas-fonts/ArsenalSC-Regular.ttf");
  mustExist(root, "canvas/canvas-fonts/WorkSans-Regular.ttf");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts -t "includes canvas-design font assets under canvas"
```

Expected: FAIL on missing license/fonts.

- [ ] **Step 3: Vendor canvas SKILL/fonts/license**

Run:

```bash
mkdir -p skills/canvas/canvas-fonts
cp /tmp/anthropic-skills/skills/canvas-design/SKILL.md skills/canvas/SKILL.md
cp /tmp/anthropic-skills/skills/canvas-design/LICENSE.txt skills/canvas/LICENSE.txt
rsync -a /tmp/anthropic-skills/skills/canvas-design/canvas-fonts/ skills/canvas/canvas-fonts/
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts -t "includes canvas-design font assets under canvas"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
scripts/committer "skills: import canvas-design assets into canvas skill" \
  src/agents/skills.bundled-anthropic-imports.test.ts \
  skills/canvas/SKILL.md skills/canvas/LICENSE.txt skills/canvas/canvas-fonts
```

---

### Task 6: Normalize SKILL Frontmatter and Metadata for OpenClaw

**Files:**

- Modify: `skills/canvas/SKILL.md`
- Modify: `skills/word-docx/SKILL.md`
- Modify: `skills/powerpoint-pptx/SKILL.md`
- Modify: `skills/excel-xlsx/SKILL.md`
- Modify: `skills/pdf/SKILL.md`
- Modify: `src/agents/skills.bundled-anthropic-imports.test.ts`
- Test: `src/agents/skills.bundled-anthropic-imports.test.ts`, `src/agents/skills/frontmatter.test.ts`

- [ ] **Step 1: Add failing assertions for frontmatter parseability and metadata compatibility**

```ts
import { parseFrontmatter, resolveOpenClawMetadata } from "./skills/frontmatter.js";

function readSkill(pathToSkill: string) {
  const raw = fs.readFileSync(pathToSkill, "utf-8");
  const frontmatter = parseFrontmatter(raw);
  expect(frontmatter.name).toBeTruthy();
  expect(frontmatter.description).toBeTruthy();
  if (frontmatter.metadata) {
    expect(resolveOpenClawMetadata(frontmatter)).toBeDefined();
  }
}

it("parses imported skill frontmatter in OpenClaw", () => {
  const skillsDir = resolveBundledSkillsDir({ cwd: process.cwd() }) as string;
  readSkill(path.join(skillsDir, "canvas/SKILL.md"));
  readSkill(path.join(skillsDir, "word-docx/SKILL.md"));
  readSkill(path.join(skillsDir, "powerpoint-pptx/SKILL.md"));
  readSkill(path.join(skillsDir, "excel-xlsx/SKILL.md"));
  readSkill(path.join(skillsDir, "pdf/SKILL.md"));
});
```

- [ ] **Step 2: Run test to verify it fails on raw upstream frontmatter mismatches**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts -t "parses imported skill frontmatter in OpenClaw"
```

Expected: FAIL if metadata/frontmatter format is incompatible.

- [ ] **Step 3: Normalize frontmatter and dependency metadata in SKILL files**

Apply these concrete frontmatter targets while editing each file:

```md
--- # skills/word-docx/SKILL.md
name: word-docx
description: Use when creating, reading, editing, or validating Microsoft Word `.docx` files, including tracked changes, comments, OOXML-level edits, and document packaging workflows.
metadata: {"openclaw":{"requires":{"bins":["python3"]},"install":[{"id":"python-brew","kind":"brew","formula":"python","bins":["python3"],"label":"Install Python (brew)"}]}}
---
```

```md
--- # skills/powerpoint-pptx/SKILL.md
name: powerpoint-pptx
description: Use when creating, editing, analyzing, or validating PowerPoint `.pptx` decks, including template-based editing, layout QA, and OOXML-level packaging workflows.
metadata: {"openclaw":{"requires":{"bins":["python3"]},"install":[{"id":"python-brew","kind":"brew","formula":"python","bins":["python3"],"label":"Install Python (brew)"}]}}
---
```

```md
--- # skills/excel-xlsx/SKILL.md
name: excel-xlsx
description: Use when creating, transforming, recalculating, or validating spreadsheet files such as `.xlsx`, including formula-preserving workflows and Office package tooling.
metadata: {"openclaw":{"requires":{"bins":["python3"]},"install":[{"id":"python-brew","kind":"brew","formula":"python","bins":["python3"],"label":"Install Python (brew)"}]}}
---
```

```md
--- # skills/pdf/SKILL.md
name: pdf
description: Use when extracting, editing, generating, or filling PDF documents, including form-field workflows and PDF validation scripts.
metadata: {"openclaw":{"requires":{"bins":["python3"]},"install":[{"id":"python-brew","kind":"brew","formula":"python","bins":["python3"],"label":"Install Python (brew)"}]}}
---
```

```md
--- # skills/canvas/SKILL.md
name: canvas
description: Use when creating high-craft visual canvas deliverables (PNG/PDF) with OpenClaw canvas workflows and bundled typography assets.
---
```

Required normalization constraints:

- Keep Office folder identity unchanged (`word-docx`, `powerpoint-pptx`, `excel-xlsx`).
- Keep `skills/pdf-extract` untouched.
- Keep metadata JSON single-line where present.
- Use only supported install `kind` values (`brew`, `node`, `go`, `uv`, `download`).

- [ ] **Step 4: Run focused tests to verify pass**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts
pnpm test -- src/agents/skills/frontmatter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
scripts/committer "skills: normalize imported anthropic SKILL frontmatter for openclaw" \
  src/agents/skills.bundled-anthropic-imports.test.ts \
  skills/canvas/SKILL.md skills/word-docx/SKILL.md \
  skills/powerpoint-pptx/SKILL.md skills/excel-xlsx/SKILL.md skills/pdf/SKILL.md
```

---

### Task 7: Update Skills Documentation for New `pdf` and Expanded Tooling

**Files:**

- Modify: `docs/tools/skills.md`
- Modify: `docs/cli/skills.md`
- Test: docs lint/check via repo check

- [ ] **Step 1: Add failing docs assertions in review checklist (manual precondition)**

Add a temporary checklist in your working notes (not committed) to enforce these updates exist:

```text
- docs/tools/skills.md mentions bundled full pdf skill (`skills/pdf`) and legacy `pdf-extract`
- docs/tools/skills.md notes office tooling footprint in bundled skills
- docs/cli/skills.md examples include `openclaw skills info pdf`
```

- [ ] **Step 2: Run doc grep to confirm text is not present yet (expected fail precondition)**

Run:

```bash
rg -n "skills/pdf|pdf-extract|skills info pdf|word-docx|powerpoint-pptx|excel-xlsx" docs/tools/skills.md docs/cli/skills.md
```

Expected: missing at least one required line/passage.

- [ ] **Step 3: Update docs to reflect new bundled skill layout**

Insert concrete docs updates:

```md
- Bundled Office-capable skills include `word-docx`, `powerpoint-pptx`, and `excel-xlsx` with skill-local helper scripts.
- PDF workflows can use full `pdf` skill; `pdf-extract` remains available for text extraction-focused flows.
```

And CLI example:

```bash
openclaw skills info pdf
```

- [ ] **Step 4: Re-run grep to verify coverage**

Run:

```bash
rg -n "skills/pdf|pdf-extract|skills info pdf|word-docx|powerpoint-pptx|excel-xlsx" docs/tools/skills.md docs/cli/skills.md
```

Expected: PASS (all required references present).

- [ ] **Step 5: Commit**

```bash
scripts/committer "docs: describe imported office/pdf bundled skills" \
  docs/tools/skills.md docs/cli/skills.md
```

---

### Task 8: End-to-End Verification and Final Integration Commit

**Files:**

- Test: `src/agents/skills.bundled-anthropic-imports.test.ts`
- Test: `src/agents/skills/frontmatter.test.ts`
- Test: repo checks

- [ ] **Step 1: Run full failing-target-to-pass verification list**

Run:

```bash
pnpm test -- src/agents/skills.bundled-anthropic-imports.test.ts
pnpm test -- src/agents/skills/frontmatter.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 2: Run runtime CLI smoke checks**

Run:

```bash
pnpm openclaw skills list
pnpm openclaw skills info word-docx
pnpm openclaw skills info powerpoint-pptx
pnpm openclaw skills info excel-xlsx
pnpm openclaw skills info pdf
```

Expected: all commands return non-error output and show updated/new skills.

- [ ] **Step 3: Verify preserved files remain unchanged where required**

Run:

```bash
git diff -- skills/pdf-extract/SKILL.md \
  skills/word-docx/_meta.json skills/word-docx/.clawhub/origin.json \
  skills/powerpoint-pptx/_meta.json skills/powerpoint-pptx/.clawhub/origin.json \
  skills/excel-xlsx/_meta.json skills/excel-xlsx/.clawhub/origin.json
```

Expected: no diff for preserved files (unless explicitly approved).

- [ ] **Step 4: Final audit of changed files and branch health**

Run:

```bash
git status --short
```

Expected: clean working tree.

- [ ] **Step 5: Commit verification evidence (if any changed artifacts remain)**

```bash
# Skip this step if no additional files changed during verification.
# If verification changed docs files, commit them explicitly, for example:
# scripts/committer "test: record verification-driven adjustments" docs/tools/skills.md docs/cli/skills.md
```

---

## Notes for Executors

1. Do not change branches during execution; stay on `anthropic-skills-openclaw-plan-2026-04-02` (or the active implementation branch assigned by maintainer).
2. Do not remove `skills/pdf-extract`.
3. Keep Office folder names as `word-docx`, `powerpoint-pptx`, and `excel-xlsx`.
4. If any imported script references unsupported external dependencies, update SKILL metadata/doc copy rather than silently removing tooling files.
