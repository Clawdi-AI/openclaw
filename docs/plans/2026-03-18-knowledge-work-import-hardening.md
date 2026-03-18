# Knowledge-Work Import Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make knowledge-work skill imports deterministic and scalable by normalizing placeholders at conversion time, removing stale upstream artifacts, and adding validation/import automation for future plugin domains.

**Architecture:** Keep runtime simple: `work-connectors` receives only canonical placeholder keys and injects a compact mapping prompt. Move variability to compile-time by adding converter transforms (`strip stale lines`, `normalize placeholders`, `warn on unknown tokens`) plus explicit validators. Add a manifest-driven importer so adding a new upstream plugin domain is a data/config action with repeatable checks.

**Tech Stack:** TypeScript (Node 22 + Bun), Vitest, existing converter (`scripts/convert-knowledge-work.ts`), existing connector hook (`extensions/work-connectors`).

---

## Execution Skills

- `@test-driven-development`
- `@verification-before-completion`
- `@systematic-debugging`

---

### Task 1: Add Canonical Placeholder Normalizer Module

**Files:**

- Create: `scripts/knowledge-work/placeholders.ts`
- Test: `scripts/knowledge-work/placeholders.test.ts`

**Step 1: Write the failing tests**

Create `scripts/knowledge-work/placeholders.test.ts` with cases for:

- canonical passthrough: `~~crm` -> `~~crm`
- case normalization: `~~CRM` -> `~~crm`
- phrase normalization: `~~product analytics` -> `~~analytics`
- phrase cleanup: `~~SEO tools` -> `~~seo`
- non-placeholder strings remain unchanged
- unknown placeholder is returned unchanged + flagged by helper

**Step 2: Run test to verify it fails**

Run:

```bash
bunx vitest run scripts/knowledge-work/placeholders.test.ts
```

Expected: FAIL (`Cannot find module './placeholders.js'` or missing exports).

**Step 3: Write minimal implementation**

Create `scripts/knowledge-work/placeholders.ts` exposing:

```ts
export type PlaceholderNormalizeResult = {
  text: string;
  unknownPlaceholders: string[];
};

export function normalizePlaceholders(input: string): PlaceholderNormalizeResult {
  // Canonicalize known variants to strict keys.
}
```

Include a single canonical key map and variant aliases in one place.

**Step 4: Run test to verify it passes**

Run:

```bash
bunx vitest run scripts/knowledge-work/placeholders.test.ts
```

Expected: PASS.

**Step 5: Commit**

Run:

```bash
scripts/committer "feat(converter): add canonical placeholder normalizer" \
  scripts/knowledge-work/placeholders.ts \
  scripts/knowledge-work/placeholders.test.ts
```

---

### Task 2: Harden Converter Output Contract

**Files:**

- Modify: `scripts/convert-knowledge-work.ts`
- Modify: `scripts/convert-knowledge-work.test.ts`

**Step 1: Write failing integration tests**

Add tests in `scripts/convert-knowledge-work.test.ts` asserting converted output:

- removes stale upstream connector note line:
  `If you see unfamiliar placeholders ... CONNECTORS.md`
- normalizes placeholder variants to canonical keys
- adds warnings for unresolved unknown placeholders discovered in body text

**Step 2: Run test to verify it fails**

Run:

```bash
bunx vitest run scripts/convert-knowledge-work.test.ts
```

Expected: FAIL on new assertions.

**Step 3: Write minimal implementation**

In `scripts/convert-knowledge-work.ts`:

- import `normalizePlaceholders`
- add a small transform pipeline before writing skill/command body:
  1. strip stale connector-note line
  2. normalize placeholders
  3. append unknown placeholder warnings to `ConversionResult.warnings`

**Step 4: Run test to verify it passes**

Run:

```bash
bunx vitest run scripts/convert-knowledge-work.test.ts
```

Expected: PASS.

**Step 5: Commit**

Run:

```bash
scripts/committer "feat(converter): normalize placeholders and strip stale connector note" \
  scripts/convert-knowledge-work.ts \
  scripts/convert-knowledge-work.test.ts
```

---

### Task 3: Add Converted-Skill Validator (CI-Friendly)

**Files:**

- Create: `scripts/knowledge-work/validate-converted.ts`
- Test: `scripts/knowledge-work/validate-converted.test.ts`

**Step 1: Write the failing tests**

Create validator tests covering:

- fails if any `CONNECTORS.md` reference remains
- fails if any non-canonical `~~...` placeholders remain
- fails if canonical placeholder in skills is missing from `extensions/work-connectors/connectors.json`
- passes on valid fixture

**Step 2: Run test to verify it fails**

Run:

```bash
bunx vitest run scripts/knowledge-work/validate-converted.test.ts
```

Expected: FAIL (module missing).

**Step 3: Write minimal implementation**

Create `scripts/knowledge-work/validate-converted.ts` CLI:

```bash
bun scripts/knowledge-work/validate-converted.ts \
  --skills-dir skills \
  --prefixes sales,marketing \
  --connectors extensions/work-connectors/connectors.json
```

Exit `1` on violations, `0` on clean state.

**Step 4: Run tests and a real validation pass**

Run:

```bash
bunx vitest run scripts/knowledge-work/validate-converted.test.ts
bun scripts/knowledge-work/validate-converted.ts --skills-dir skills --prefixes sales,marketing --connectors extensions/work-connectors/connectors.json
```

Expected: test PASS; validator exits clean on repository state after migration task.

**Step 5: Commit**

Run:

```bash
scripts/committer "feat(converter): add converted-skill validation CLI" \
  scripts/knowledge-work/validate-converted.ts \
  scripts/knowledge-work/validate-converted.test.ts
```

---

### Task 4: Add Manifest-Driven Import CLI for New Plugin Domains

**Files:**

- Create: `scripts/knowledge-work/import-manifest.json`
- Create: `scripts/knowledge-work/import-knowledge-work.ts`
- Test: `scripts/knowledge-work/import-knowledge-work.test.ts`
- Modify: `scripts/convert-knowledge-work.ts` (only if small export/helper refactor is needed)

**Step 1: Write failing tests**

Add tests for:

- reads manifest entries (`sourceDir`, `prefix`, `emoji`, `enabled`)
- converts only enabled entries
- supports `--only <prefixes>`
- supports `--dry-run` output summary without writing files

**Step 2: Run test to verify it fails**

Run:

```bash
bunx vitest run scripts/knowledge-work/import-knowledge-work.test.ts
```

Expected: FAIL (module missing).

**Step 3: Write minimal implementation**

Implement importer CLI that orchestrates existing `convertPlugin` and prints:

- converted counts
- unresolved placeholder warnings
- next action hint (`run validate-converted`)

**Step 4: Run tests and smoke importer**

Run:

```bash
bunx vitest run scripts/knowledge-work/import-knowledge-work.test.ts
bun scripts/knowledge-work/import-knowledge-work.ts --manifest scripts/knowledge-work/import-manifest.json --dry-run
```

Expected: tests PASS; dry-run summary prints without file writes.

**Step 5: Commit**

Run:

```bash
scripts/committer "feat(converter): add manifest-driven knowledge-work importer" \
  scripts/knowledge-work/import-manifest.json \
  scripts/knowledge-work/import-knowledge-work.ts \
  scripts/knowledge-work/import-knowledge-work.test.ts \
  scripts/convert-knowledge-work.ts
```

---

### Task 5: Re-generate Sales + Marketing Skills with Hardened Pipeline

**Files:**

- Modify (generated): `skills/sales-*/SKILL.md`
- Modify (generated): `skills/marketing-*/SKILL.md`

**Step 1: Run importer for current rollout scope**

Run:

```bash
bun scripts/knowledge-work/import-knowledge-work.ts \
  --manifest scripts/knowledge-work/import-manifest.json \
  --only sales,marketing
```

Expected: files rewritten with canonical placeholders and no stale `CONNECTORS.md` note lines.

**Step 2: Validate generated output**

Run:

```bash
bun scripts/knowledge-work/validate-converted.ts --skills-dir skills --prefixes sales,marketing --connectors extensions/work-connectors/connectors.json
```

Expected: exit code `0`.

**Step 3: Run focused regression tests**

Run:

```bash
bunx vitest run scripts/convert-knowledge-work.test.ts
bunx vitest run extensions/work-connectors/src/hook.test.ts
```

Expected: PASS.

**Step 4: Review diff safety**

Run:

```bash
git diff -- skills/sales-* skills/marketing-* | rg -n "CONNECTORS.md|~~"
```

Expected: no `CONNECTORS.md` lines; only canonical placeholders remain.

**Step 5: Commit**

Run:

```bash
scripts/committer "refactor(skills): regenerate sales and marketing with canonical placeholders" \
  skills/sales-account-research/SKILL.md \
  skills/sales-call-prep/SKILL.md \
  skills/sales-call-summary/SKILL.md \
  skills/sales-competitive-intelligence/SKILL.md \
  skills/sales-create-an-asset/SKILL.md \
  skills/sales-daily-briefing/SKILL.md \
  skills/sales-draft-outreach/SKILL.md \
  skills/sales-forecast/SKILL.md \
  skills/sales-pipeline-review/SKILL.md \
  skills/marketing-brand-review/SKILL.md \
  skills/marketing-campaign-plan/SKILL.md \
  skills/marketing-competitive-brief/SKILL.md \
  skills/marketing-content-creation/SKILL.md \
  skills/marketing-draft-content/SKILL.md \
  skills/marketing-email-sequence/SKILL.md \
  skills/marketing-performance-report/SKILL.md \
  skills/marketing-seo-audit/SKILL.md
```

---

### Task 6: Document the Dynamic Add Flow for Future Domains

**Files:**

- Create: `docs/reference/knowledge-work-plugins.md`
- Modify: `docs/tools/skills.md` (add pointer under relevant section)

**Step 1: Write docs content**

Document:

- canonical placeholder policy (compile-time normalization)
- add-a-domain flow (`manifest` -> `import` -> `validate` -> `commit`)
- when restart is needed (plugin/config changes) vs when watcher/new session is enough for skill file changes

**Step 2: Run docs checks**

Run:

```bash
pnpm format:docs
pnpm docs:check-links
```

Expected: PASS.

**Step 3: Run final verification set**

Run:

```bash
bunx vitest run scripts/convert-knowledge-work.test.ts \
  scripts/knowledge-work/placeholders.test.ts \
  scripts/knowledge-work/validate-converted.test.ts \
  scripts/knowledge-work/import-knowledge-work.test.ts \
  extensions/work-connectors/src/hook.test.ts
```

Expected: PASS.

**Step 4: Commit**

Run:

```bash
scripts/committer "docs(skills): add knowledge-work import and validation runbook" \
  docs/reference/knowledge-work-plugins.md \
  docs/tools/skills.md
```

---

## Definition of Done

- Converted skills no longer contain stale `CONNECTORS.md` note lines.
- Converted skills use canonical placeholders only.
- Validation CLI blocks non-canonical placeholders and missing connector keys.
- Importer CLI supports manifest-driven onboarding for additional plugin domains.
- Sales + marketing skills are regenerated and validated with no behavior regressions in converter/hook tests.
- Runbook exists for repeatable dynamic onboarding.

## Suggested Next Domains (post-rollout)

1. `engineering`
2. `data`
3. `legal`
4. `operations`
