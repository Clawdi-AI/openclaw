# Financial Services Mcporter Rename Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename the migrated financial-services extensions to bare domain names and replace the financial-analysis metadata-only MCP preservation with a working `mcporter`-backed connector bridge.

**Architecture:** Treat `financial-analysis` as the core extension that owns financial data connector execution. Rename the five migrated extension folders, package names, plugin ids, and README/display names to bare names (`financial-analysis`, `investment-banking`, `equity-research`, `private-equity`, `wealth-management`). In `financial-analysis`, replace the current connector inspection-only helper with a `mcporter` client layer plus a tool that can list connectors, list remote MCP tools, and call a selected MCP tool through `mcporter`. Update MCP-referencing skill text in the core and add-on packages so they refer to the OpenClaw runtime bridge instead of generic Anthropic MCP availability.

**Tech Stack:** TypeScript ESM, OpenClaw plugin SDK, TypeBox, Node child-process spawning, Vitest, pnpm workspace packages.

---

### Task 1: Rename the extension packages to bare names

**Files:**

- Move: `extensions/anthropic-financial-analysis` -> `extensions/financial-analysis`
- Move: `extensions/anthropic-investment-banking` -> `extensions/investment-banking`
- Move: `extensions/anthropic-equity-research` -> `extensions/equity-research`
- Move: `extensions/anthropic-private-equity` -> `extensions/private-equity`
- Move: `extensions/anthropic-wealth-management` -> `extensions/wealth-management`
- Modify: `.github/labeler.yml`
- Modify: `pnpm-lock.yaml`

**Step 1: Rename the directories**

Run:

```bash
mv extensions/anthropic-financial-analysis extensions/financial-analysis
mv extensions/anthropic-investment-banking extensions/investment-banking
mv extensions/anthropic-equity-research extensions/equity-research
mv extensions/anthropic-private-equity extensions/private-equity
mv extensions/anthropic-wealth-management extensions/wealth-management
```

Expected: all five directories move cleanly and `git status --short` shows the renames.

**Step 2: Update package metadata**

Modify each package:

- `extensions/financial-analysis/package.json`
- `extensions/investment-banking/package.json`
- `extensions/equity-research/package.json`
- `extensions/private-equity/package.json`
- `extensions/wealth-management/package.json`

Change:

- `name` from `@openclaw/anthropic-*` to `@openclaw/<bare-name>`
- `openclaw.install.localPath` to the new folder path
- descriptions to remove `Anthropic` from user-facing naming while keeping source attribution in prose where useful

**Step 3: Update plugin manifests**

Modify:

- `extensions/financial-analysis/openclaw.plugin.json`
- `extensions/investment-banking/openclaw.plugin.json`
- `extensions/equity-research/openclaw.plugin.json`
- `extensions/private-equity/openclaw.plugin.json`
- `extensions/wealth-management/openclaw.plugin.json`

Change:

- `id` to the bare name
- `name` to the bare display name
- description text to refer to “Anthropic source plugin” only as provenance, not branding

**Step 4: Update labeler entries**

Replace the `extensions: anthropic-*` entries in `.github/labeler.yml` with:

- `extensions: financial-analysis`
- `extensions: investment-banking`
- `extensions: equity-research`
- `extensions: private-equity`
- `extensions: wealth-management`

Expected: label globs point at the new directories.

**Step 5: Refresh the lockfile after rename**

Run:

```bash
CI=true corepack pnpm install --no-frozen-lockfile
```

Expected: `pnpm-lock.yaml` importer paths switch from `extensions/anthropic-*` to the bare extension paths.

### Task 2: Write the failing tests for the mcporter client

**Files:**

- Create: `extensions/financial-analysis/src/lib/mcporter.test.ts`

**Step 1: Write the failing test**

Cover the reusable `mcporter` client behavior:

- builds the correct `mcporter call` arguments for remote HTTP MCP endpoints
- forwards connector headers and auth material without hardcoding provider-specific behavior
- parses JSON output
- reports actionable errors when `mcporter` is missing or returns invalid JSON

Use the `lobster` tool test pattern as the template for mocking `node:child_process.spawn`.

**Step 2: Run the test to verify it fails**

Run:

```bash
corepack pnpm exec vitest run extensions/financial-analysis/src/lib/mcporter.test.ts --maxWorkers=1
```

Expected: FAIL because `./mcporter.js` does not exist yet.

### Task 3: Implement the reusable mcporter client

**Files:**

- Create: `extensions/financial-analysis/src/lib/mcporter.ts`

**Step 1: Implement the minimal client**

Create a small helper that:

- resolves the `mcporter` executable from plugin config or `PATH`
- supports:
  - `listTools({ url, headers })`
  - `callTool({ url, headers, toolName, args })`
- spawns `mcporter` in JSON-friendly mode
- parses stdout
- throws clear errors for missing binary, non-zero exit, or invalid JSON

**Step 2: Keep the helper generic**

Do not bake in `daloopa`, `factset`, or other provider names. The helper should only know:

- MCP server URL
- headers
- tool name
- JSON args

**Step 3: Run the focused test**

Run:

```bash
corepack pnpm exec vitest run extensions/financial-analysis/src/lib/mcporter.test.ts --maxWorkers=1
```

Expected: PASS

### Task 4: Expand the connector tests to require real mcporter-backed behavior

**Files:**

- Modify: `extensions/financial-analysis/src/workflow-tools.test.ts`

**Step 1: Replace the metadata-only expectations**

Update the existing connector tests so they now assert:

- resolved connectors report `supportLevel: "mcporter"`
- a connector tool can list remote tools through the mocked `mcporter` client
- a connector tool can call a remote MCP method and return structured output

**Step 2: Add failure-path assertions**

Test at least:

- disabled connector rejection
- unknown connector rejection
- missing auth/header config handled explicitly

**Step 3: Run the test to verify it fails**

Run:

```bash
corepack pnpm exec vitest run extensions/financial-analysis/src/workflow-tools.test.ts --maxWorkers=1
```

Expected: FAIL because the connector tool still reports metadata-only behavior.

### Task 5: Replace the metadata-only connector helper with a mcporter-backed bridge

**Files:**

- Modify: `extensions/financial-analysis/src/lib/connectors.ts`
- Modify: `extensions/financial-analysis/src/index.ts`

**Step 1: Evolve the connector config model**

Update connector resolution to support generic auth/header configuration:

- `enabled?: boolean`
- `baseUrl?: string`
- `apiKey?: string`
- `apiKeyHeader?: string`
- `apiKeyPrefix?: string`
- `headers?: Record<string, string>`

Resolve headers at runtime by merging:

- static `headers`
- derived header from `apiKey` + `apiKeyHeader` + `apiKeyPrefix`

**Step 2: Replace support metadata**

Change:

- `supportLevel: "metadata_only"` -> `supportLevel: "mcporter"`
- add any runtime fields needed by the bridge, such as resolved headers

**Step 3: Replace the current connector tool**

Keep the existing tool name `financial_analysis_connectors`, but expand its actions to:

- `list_connectors`
- `describe_connector`
- `list_tools`
- `call_tool`

Parameters should remain a flat object schema, for example:

```ts
{
  action: "list_connectors" | "describe_connector" | "list_tools" | "call_tool",
  connector?: string,
  toolName?: string,
  argsJson?: string
}
```

Parse `argsJson` into a JSON payload before calling the mcporter client.

**Step 4: Wire the client into the tool**

`extensions/financial-analysis/src/index.ts` should continue registering the financial workflows plus the connector tool, but the connector tool now uses the new `mcporter` client.

**Step 5: Run the focused tests**

Run:

```bash
corepack pnpm exec vitest run \
  extensions/financial-analysis/src/lib/mcporter.test.ts \
  extensions/financial-analysis/src/workflow-tools.test.ts \
  --maxWorkers=1
```

Expected: PASS

### Task 6: Update the financial-analysis manifest for mcporter-backed connector config

**Files:**

- Modify: `extensions/financial-analysis/openclaw.plugin.json`

**Step 1: Extend the connector schema**

For every connector entry, add:

- `apiKeyHeader`
- `apiKeyPrefix`
- `headers`

Use JSON Schema object form for `headers`:

```json
{
  "type": "object",
  "additionalProperties": { "type": "string" }
}
```

**Step 2: Update UI hints**

Add hints for:

- `apiKeyHeader`
- `apiKeyPrefix`
- `headers`
- optional `mcporterPath` if you decide to support explicit binary override

Mark secret fields as sensitive only where appropriate.

**Step 3: Keep defaults conservative**

Use Bearer-token defaults only where they are defensible; otherwise leave header details explicit so the operator can configure them.

### Task 7: Update MCP-referencing skills and READMEs to point at the OpenClaw bridge

**Files:**

- Modify: `extensions/financial-analysis/README.md`
- Modify: `extensions/investment-banking/README.md`
- Modify: `extensions/equity-research/README.md`
- Modify: `extensions/private-equity/README.md`
- Modify: `extensions/wealth-management/README.md`
- Modify: `extensions/financial-analysis/skills/comps-analysis/SKILL.md`
- Modify: `extensions/financial-analysis/skills/dcf-model/SKILL.md`
- Modify: any migrated skill found by:

```bash
rg -n "MCP" extensions/financial-analysis/skills extensions/investment-banking/skills extensions/equity-research/skills extensions/private-equity/skills extensions/wealth-management/skills
```

**Step 1: Update the core README**

Explain that:

- `financial-analysis` is the core package
- MCP-backed financial data now flows through the `financial_analysis_connectors` tool and `mcporter`
- add-on packages assume `financial-analysis` is installed when they mention connector-backed data

**Step 2: Update the copied skill text**

Replace phrasing like “if MCP servers are available” with OpenClaw-specific phrasing such as:

- “if the `financial_analysis_connectors` tool is configured”
- “use the financial-analysis mcporter bridge for verified financial data”

Do not rewrite the substantive financial workflow; only swap the runtime references.

**Step 3: Update add-on READMEs**

State clearly that:

- `investment-banking`, `equity-research`, `private-equity`, and `wealth-management` are add-ons
- install `financial-analysis` first if connector-backed financial data is needed

### Task 8: Sweep the remaining bare-name rename references

**Files:**

- Modify: `docs/plans/2026-03-13-anthropic-financial-services-plugin-migration.md`
- Modify: any README or code path still containing `anthropic-` under the renamed extension folders

**Step 1: Find stale names**

Run:

```bash
rg -n "anthropic-(financial-analysis|investment-banking|equity-research|private-equity|wealth-management)|Anthropic Financial Analysis|Anthropic Investment Banking|Anthropic Equity Research|Anthropic Private Equity|Anthropic Wealth Management" \
  extensions/financial-analysis \
  extensions/investment-banking \
  extensions/equity-research \
  extensions/private-equity \
  extensions/wealth-management \
  docs/plans
```

Expected: only intentional source-attribution prose remains.

**Step 2: Remove stale path references**

Update plan docs and local install paths so they refer to the bare directories.

### Task 9: Final verification

**Files:**

- Test: `extensions/financial-analysis/src/lib/mcporter.test.ts`
- Test: `extensions/financial-analysis/src/workflow-tools.test.ts`
- Review: all five renamed extension packages

**Step 1: Run focused tests**

Run:

```bash
corepack pnpm exec vitest run \
  extensions/financial-analysis/src/lib/mcporter.test.ts \
  extensions/financial-analysis/src/workflow-tools.test.ts \
  --maxWorkers=1
```

Expected: PASS

**Step 2: Run typecheck**

Run:

```bash
corepack pnpm tsgo
```

Expected: PASS

**Step 3: Run lint**

Run:

```bash
corepack pnpm lint
```

Expected: PASS

**Step 4: Refresh formatting if needed**

Run:

```bash
corepack pnpm format
```

Expected: formatting-only updates, no semantic drift.

### Task 10: Delivery summary

**Files:**

- Review: `git status --short`
- Review: `git diff --stat`

**Step 1: Summarize the final shape**

Report:

- renamed bare-name extension packages
- `financial-analysis` now provides a real mcporter-backed MCP bridge
- add-ons depend on the core package for connector-backed data

**Step 2: Call out residual risks**

Include:

- provider-specific auth/header details may still need operator tuning
- partner-built financial plugins are still out of scope
- GitHub labels matching the new labeler entries must be created remotely if they do not already exist
