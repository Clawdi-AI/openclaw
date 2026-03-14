# Anthropic Financial Services Plugin Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the first-party Anthropic Financial Services plugins into OpenClaw extensions that preserve skills, map slash commands to OpenClaw tools, and represent MCP connector intent explicitly without pretending OpenClaw can consume `.mcp.json` directly.

**Architecture:** Add five self-contained extension packages under `extensions/` for `financial-analysis`, `investment-banking`, `equity-research`, `private-equity`, and `wealth-management`. Each package will ship the migrated `skills/` tree, a manifest-first `openclaw.plugin.json`, a thin TypeScript registration layer in `src/index.ts`, and metadata-driven workflow tools generated from the Anthropic command set. Only `financial-analysis` will expose connector config/runtime helpers because it is the only first-party plugin with a non-empty `.mcp.json`.

**Tech Stack:** TypeScript ESM, OpenClaw plugin SDK, TypeBox for tool schemas, Vitest, JSON Schema manifests.

---

### Task 1: Inspect and codify the Anthropic source inventory

**Files:**

- Read: `/tmp/financial-services-plugins/README.md`
- Read: `/tmp/financial-services-plugins/{financial-analysis,investment-banking,equity-research,private-equity,wealth-management}/.claude-plugin/plugin.json`
- Read: `/tmp/financial-services-plugins/financial-analysis/.mcp.json`
- Read: `/tmp/financial-services-plugins/{financial-analysis,investment-banking,equity-research,private-equity,wealth-management}/commands/*.md`
- Read: `/tmp/financial-services-plugins/{financial-analysis,investment-banking,equity-research,private-equity,wealth-management}/skills/**`

**Step 1: Capture the source plugin inventory**

Document the five first-party Anthropic plugins, their skill counts, command names, and whether they include connector definitions.

**Step 2: Confirm partner-built scope**

Treat `partner-built/lseg` and `partner-built/spglobal` as out of scope for this pass because they lack `.claude-plugin/plugin.json` manifests. Note that decision in the migration README files.

**Step 3: Freeze extension ids and folder names**

Use:

- `extensions/anthropic-financial-analysis`
- `extensions/anthropic-investment-banking`
- `extensions/anthropic-equity-research`
- `extensions/anthropic-private-equity`
- `extensions/anthropic-wealth-management`

**Step 4: Commit planning checkpoint**

No commit yet; proceed directly into TDD scaffolding.

### Task 2: Write the failing tests for the shared workflow-tool behavior

**Files:**

- Create: `extensions/anthropic-financial-analysis/src/workflow-tools.test.ts`

**Step 1: Write the failing test**

Cover the generic behavior that all migrated command tools should share:

- command metadata becomes a registered tool
- missing required `target` input is reported clearly
- tool output includes migrated skill names and expected deliverables
- connector status tool exposes default endpoints but marks transport unsupported

**Step 2: Run test to verify it fails**

Run: `pnpm test -- --runInBand extensions/anthropic-financial-analysis/src/workflow-tools.test.ts`
Expected: FAIL because the new extension files do not exist yet.

**Step 3: Keep the test scope small**

Do not test all 38 commands individually. Test one representative workflow tool and one connector helper, then reuse the same production helper across all five extensions.

### Task 3: Implement the reusable workflow-tool helper and connector helper

**Files:**

- Create: `extensions/anthropic-financial-analysis/src/lib/workflow-tool.ts`
- Create: `extensions/anthropic-financial-analysis/src/lib/connectors.ts`
- Create: `extensions/anthropic-financial-analysis/src/lib/catalog.ts`
- Create: `extensions/anthropic-financial-analysis/src/index.ts`

**Step 1: Implement the failing workflow tool path**

Create a metadata-driven tool factory that:

- takes workflow specs (`toolName`, `commandName`, `description`, `skillNames`, `argHint`, `deliverables`, `requiredInputs`, `notes`)
- registers one tool per Anthropic command
- accepts a minimal schema with `target` and optional `context`
- returns structured text + JSON details that tell the agent which migrated skills to use and what artifacts to produce

**Step 2: Implement connector helpers**

Add a connector catalog for `financial-analysis` that:

- exposes the Anthropic MCP endpoints as config defaults
- supports `list`, `status`, and `describe` behavior
- clearly reports that OpenClaw currently ignores MCP server configs, so the extension only preserves connector metadata/config, not live MCP invocation

**Step 3: Run the focused tests**

Run: `pnpm test -- --runInBand extensions/anthropic-financial-analysis/src/workflow-tools.test.ts`
Expected: PASS

### Task 4: Scaffold the five extension packages

**Files:**

- Create: `extensions/anthropic-financial-analysis/{openclaw.plugin.json,package.json,README.md}`
- Create: `extensions/anthropic-investment-banking/{openclaw.plugin.json,package.json,README.md,src/index.ts,src/lib/catalog.ts,src/lib/workflow-tool.ts}`
- Create: `extensions/anthropic-equity-research/{openclaw.plugin.json,package.json,README.md,src/index.ts,src/lib/catalog.ts,src/lib/workflow-tool.ts}`
- Create: `extensions/anthropic-private-equity/{openclaw.plugin.json,package.json,README.md,src/index.ts,src/lib/catalog.ts,src/lib/workflow-tool.ts}`
- Create: `extensions/anthropic-wealth-management/{openclaw.plugin.json,package.json,README.md,src/index.ts,src/lib/catalog.ts,src/lib/workflow-tool.ts}`

**Step 1: Add package metadata**

Each extension package should:

- be private
- point `openclaw.extensions` at `./src/index.ts`
- keep `openclaw` in `devDependencies`

**Step 2: Add manifest metadata**

Each manifest should:

- declare `id`, `name`, `description`
- include `skills: ["./skills"]`
- define explicit `configSchema`
- use `uiHints` to mark API key fields as sensitive where applicable

**Step 3: Register workflow tools**

Map every Anthropic command to an OpenClaw tool. Keep the implementation thin and metadata-driven.

**Step 4: Copy the reusable helper**

Keep each package self-contained for installation. Duplicate the small workflow helper where needed rather than importing from a sibling extension.

### Task 5: Copy and lightly normalize the skill trees

**Files:**

- Create: `extensions/anthropic-financial-analysis/skills/**`
- Create: `extensions/anthropic-investment-banking/skills/**`
- Create: `extensions/anthropic-equity-research/skills/**`
- Create: `extensions/anthropic-private-equity/skills/**`
- Create: `extensions/anthropic-wealth-management/skills/**`

**Step 1: Preserve the Anthropic skill directories**

Copy the skill folder layout directly under each extension’s `skills/` directory.

**Step 2: Apply only minimal normalization**

Adjust only obviously broken relative references or wording that assumes Anthropic-only slash commands. Preserve the substantive workflow guidance.

**Step 3: Do not invent runtime capabilities**

If a skill depends on MCP or PowerPoint/Excel automation that OpenClaw does not provide directly, keep the instructions but note the limitation in the package README instead of rewriting the skill into false certainty.

### Task 6: Add package READMEs that document mapping and gaps

**Files:**

- Modify: `extensions/anthropic-financial-analysis/README.md`
- Modify: `extensions/anthropic-investment-banking/README.md`
- Modify: `extensions/anthropic-equity-research/README.md`
- Modify: `extensions/anthropic-private-equity/README.md`
- Modify: `extensions/anthropic-wealth-management/README.md`

**Step 1: Document the migration summary**

For each package README, include:

- what the Anthropic plugin did
- what was preserved
- what changed in OpenClaw
- unsupported/ambiguous areas

**Step 2: Document command mapping**

List Anthropic slash commands and the corresponding OpenClaw tool names.

**Step 3: Document connector handling**

In `anthropic-financial-analysis`, explain the `.mcp.json` mapping into manifest config and the explicit non-support for native MCP invocation.

### Task 7: Verify with repo checks

**Files:**

- Test: `extensions/anthropic-financial-analysis/src/workflow-tools.test.ts`
- Test: any additional tests created during implementation

**Step 1: Run the targeted tests**

Run: `pnpm test -- --runInBand extensions/anthropic-financial-analysis/src/workflow-tools.test.ts`
Expected: PASS

**Step 2: Run type-aware validation for the new extensions**

Run: `pnpm tsgo`
Expected: PASS

**Step 3: Run formatting/lint checks if the new code triggers them**

Run: `pnpm format:fix`
Run: `pnpm lint`
Expected: PASS

### Task 8: Prepare the delivery summary

**Files:**

- Review: all new extension package paths under `extensions/anthropic-*`

**Step 1: Capture migration findings**

Summarize:

- five migrated plugins delivered
- partner-built plugins deferred
- `.mcp.json` preserved as config metadata, not live transport

**Step 2: Provide the final user handoff**

Report the branch, verification results, key file paths, and any unresolved gaps.
