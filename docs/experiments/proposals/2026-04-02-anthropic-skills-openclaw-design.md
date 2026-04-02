# Anthropic Office and Canvas Skills Integration Design

## Summary

Integrate selected skills from `anthropics/skills` into OpenClaw while preserving OpenClaw naming/style conventions and including upstream tooling payloads.

Chosen approach: **Hybrid (Approach 3)**.

- **Phase 1 (parity-first):** Vendor upstream skill content and tooling into OpenClaw skill folders with minimal behavioral drift.
- **Phase 2 (dedupe):** Optionally consolidate duplicated Office runtime/tooling after parity is validated.

## Goals

1. Add/upgrade skill capabilities for canvas art workflows and Office document workflows.
2. Keep existing OpenClaw skill slugs for Office skills to avoid breaking user configs and references.
3. Include upstream tooling assets/scripts in Phase 1.
4. Normalize imported skills to OpenClaw frontmatter/style expectations.
5. Keep rollout safe via explicit validation gates.

## Non-Goals

1. Rewriting upstream Office toolchain behavior during Phase 1.
2. Replacing existing `skills/pdf-extract` behavior.
3. Performing broad refactors across unrelated skills.

## Scope

### In Scope

- `canvas-design` -> `skills/canvas`
- `docx` -> `skills/word-docx`
- `pptx` -> `skills/powerpoint-pptx`
- `xlsx` -> `skills/excel-xlsx`
- `pdf` -> `skills/pdf` (new full-feature skill), while preserving `skills/pdf-extract`

### Out of Scope

- Removing existing `skills/pdf-extract`
- Plugin-level skill packaging changes
- Cross-repo changes outside this OpenClaw repository

## Current State and Constraints

1. OpenClaw already contains:
   - `skills/word-docx`
   - `skills/powerpoint-pptx`
   - `skills/excel-xlsx`
   - `skills/canvas`
   - `skills/pdf-extract`
2. Existing Office skills in this repo are currently lightweight (`SKILL.md` + metadata) compared to Anthropic upstream tooling bundles.
3. OpenClaw skill parser and docs expect:
   - `SKILL.md` with YAML frontmatter (`name`, `description`, optional keys)
   - `metadata` as single-line JSON where `metadata.openclaw.*` is used
   - compatibility with `skills` discovery/eligibility rules

## Design Decisions

### 1) Slug and folder strategy

Use existing OpenClaw slugs/folders for Office skills:

- `word-docx` (not `docx`)
- `powerpoint-pptx` (not `pptx`)
- `excel-xlsx` (not `xlsx`)

For PDF, add a separate full skill at `skills/pdf` while retaining `skills/pdf-extract`.

### 2) Phase 1 parity import strategy

Vendor upstream content directly into target skill folders, then normalize frontmatter/style for OpenClaw.

This includes upstream scripts/assets/reference files required by each skill.

### 3) OpenClaw style normalization

Normalize imported skills to repository conventions:

1. Keep concise American English copy.
2. Ensure frontmatter works with OpenClaw parsing conventions.
3. Add/adjust `metadata.openclaw.requires` and `install` entries where binaries are required.
4. Ensure script paths are skill-local and consistent with OpenClaw invocation context (`{baseDir}` or equivalent local-relative usage).

### 4) Safe compatibility posture

Do not remove or rename existing Office skill folders. Do not remove `skills/pdf-extract`.

## File and Asset Mapping

### `skills/canvas`

Phase 1 changes:

1. Replace/merge `SKILL.md` content with canvas-design workflow adapted for OpenClaw canvas/node usage.
2. Add upstream font payload under `skills/canvas/canvas-fonts/*`.
3. Add license file(s) from upstream skill.

### `skills/word-docx`

Phase 1 changes:

1. Replace/merge `SKILL.md` using upstream `docx` guidance normalized to OpenClaw style.
2. Add tooling:
   - `scripts/accept_changes.py`
   - `scripts/comment.py`
   - `scripts/office/**` (including validators/schemas/helpers)
   - `scripts/templates/**`
3. Keep existing `.clawhub` metadata unless explicitly changed.

### `skills/powerpoint-pptx`

Phase 1 changes:

1. Replace/merge `SKILL.md` with upstream `pptx` guidance normalized to OpenClaw style.
2. Add references:
   - `editing.md`
   - `pptxgenjs.md`
3. Add tooling:
   - `scripts/add_slide.py`
   - `scripts/clean.py`
   - `scripts/thumbnail.py`
   - `scripts/office/**`

### `skills/excel-xlsx`

Phase 1 changes:

1. Replace/merge `SKILL.md` with upstream `xlsx` guidance normalized to OpenClaw style.
2. Add tooling:
   - `scripts/recalc.py`
   - `scripts/office/**`

### `skills/pdf` (new)

Phase 1 changes:

1. Create new skill folder `skills/pdf`.
2. Add:
   - `SKILL.md`
   - `forms.md`
   - `reference.md`
   - `scripts/*.py` from upstream pdf skill
   - license file(s)

### Preserve existing `skills/pdf-extract`

No breaking rename/removal in Phase 1. It remains available for existing users.

## Dependencies and Runtime Requirements

Expected binary/runtime dependencies introduced or emphasized:

1. Python 3 for tool scripts.
2. LibreOffice (`soffice`) for office conversion/recalc workflows used by Office skill tooling.
3. Poppler utilities in workflows where image/PDF conversion helpers are used (for example `pdftoppm`, `pdftotext`) when referenced by skill instructions.
4. Optional JS ecosystem tools mentioned by skill docs (for example `docx`/`pptxgenjs`) should be documented as user/runtime prerequisites where needed.

## Risks and Mitigations

1. **Risk:** Large payload growth from duplicated `scripts/office/**` in three skills.
   - **Mitigation:** Accept in Phase 1 for parity; evaluate shared runtime in Phase 2.
2. **Risk:** Frontmatter incompatibility with OpenClaw parser.
   - **Mitigation:** Normalize frontmatter fields and validate with existing skills tests.
3. **Risk:** Dependency assumptions (`soffice`, poppler, python modules) failing on user environments.
   - **Mitigation:** Add explicit requirements and install hints via `metadata.openclaw.requires/install` where applicable.
4. **Risk:** Behavior confusion between `skills/pdf` and `skills/pdf-extract`.
   - **Mitigation:** Keep descriptions sharply differentiated and preserve backward compatibility.

## Validation Plan

### Automated checks

1. Run targeted skills tests (`src/agents/skills*` subset relevant to discovery/frontmatter/eligibility).
2. Run repo check command (`pnpm check`) for lint/format consistency.

### Skill-level smoke checks

1. DOCX/PPTX/XLSX:
   - Verify skill-local script paths resolve.
   - Run lightweight script sanity checks (`--help` or import-level checks) where supported.
2. PDF:
   - Verify script sanity/import checks for bundled Python scripts.
3. Canvas:
   - Verify `canvas-fonts` assets exist and references in `SKILL.md` are valid.

### Runtime visibility checks

1. Verify `openclaw skills list` shows expected entries.
2. Verify `openclaw skills info <skill>` for updated/new skills.

## Rollout Plan

### Phase 1 (this effort)

1. Import and normalize content for the five target skills.
2. Preserve existing Office slugs and `pdf-extract`.
3. Validate with tests/checks and skill smoke checks.

### Phase 2 (optional follow-up)

1. Evaluate extracting shared Office runtime/tooling to reduce duplication.
2. Update Office skills to consume shared runtime without behavior regressions.
3. Re-run validation and compare parity against Phase 1 behavior.

## Acceptance Criteria

1. The five target skills are present and updated per mapping.
2. Office skills retain OpenClaw slugs (`word-docx`, `powerpoint-pptx`, `excel-xlsx`).
3. A new `skills/pdf` exists while `skills/pdf-extract` remains intact.
4. Upstream tooling payloads are included in Phase 1 for target skills.
5. OpenClaw skills discovery and frontmatter parsing continue to work.
6. Validation commands pass or have clearly documented actionable failures.

## Open Questions for Implementation Planning

1. Do we want to immediately add/update docs pages for new `skills/pdf` and expanded tooling expectations, or defer docs updates to a separate PR?
2. Should we preserve existing skill metadata files (`_meta.json`, `.clawhub/origin.json`) unchanged for migrated skills in this pass?
3. Should we add one or more targeted regression tests specifically for the new `skills/pdf` presence and Office skill expanded file trees?
