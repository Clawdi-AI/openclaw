# Knowledge-Work Import Runbook

This folder contains the conversion pipeline for importing upstream
`knowledge-work-plugins` into OpenClaw skills with deterministic output.

## Files

- `import-manifest.json`: plugin list and conversion metadata (`sourceDir`, `prefix`, `emoji`, `enabled`)
- `import-knowledge-work.ts`: manifest-driven importer
- `validate-converted.ts`: post-conversion contract validator
- `placeholders.ts`: canonical placeholder normalizer

## Workflow

1. Dry-run the import (no file writes):

```bash
bun scripts/knowledge-work/import-knowledge-work.ts \
  --manifest scripts/knowledge-work/import-manifest.json \
  --dry-run
```

2. Import enabled plugin entries from the manifest:

```bash
bun scripts/knowledge-work/import-knowledge-work.ts \
  --manifest scripts/knowledge-work/import-manifest.json
```

3. Validate converted output:

```bash
bun scripts/knowledge-work/validate-converted.ts \
  --skills-dir skills \
  --prefixes sales,marketing \
  --connectors extensions/work-connectors/connectors.json
```

Validation fails when any converted skill still has:

- `CONNECTORS.md` references
- non-canonical placeholder tokens/aliases
- canonical placeholders missing from connector mappings

## Targeted Imports

Import only specific prefixes (comma-separated):

```bash
bun scripts/knowledge-work/import-knowledge-work.ts \
  --manifest scripts/knowledge-work/import-manifest.json \
  --only sales
```
