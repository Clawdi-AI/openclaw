# Financial Analysis for OpenClaw

This extension migrates the source `financial-analysis` plugin into OpenClaw. It preserves the original skill pack, exposes the source slash commands as OpenClaw workflow tools, and routes configured financial data connectors through `mcporter`.

## Preserved

- Skills under [`skills/`](./skills) for comps, DCF, LBO, 3-statement modeling, deck QC, and template authoring.
- Workflow entry points for `/3-statement-model`, `/check-deck`, `/competitive-analysis`, `/comps`, `/dcf`, `/debug-model`, `/lbo`, and `/ppt-template`.
- The original connector inventory from `.mcp.json` as explicit OpenClaw config.

## Changed

- Source slash commands are now OpenClaw tools:
  - `/3-statement-model` -> `financial_analysis_three_statement_model`
  - `/check-deck` -> `financial_analysis_check_deck`
  - `/competitive-analysis` -> `financial_analysis_competitive_analysis`
  - `/comps` -> `financial_analysis_comps`
  - `/dcf` -> `financial_analysis_dcf`
  - `/debug-model` -> `financial_analysis_debug_model`
  - `/lbo` -> `financial_analysis_lbo`
  - `/ppt-template` -> `financial_analysis_ppt_template`
- Connector inspection and runtime calls are available through `financial_analysis_connectors`.

## Connector Notes

OpenClaw does not execute source `.mcp.json` files directly. This extension converts that connector intent into explicit OpenClaw config plus a `mcporter` bridge:

- `mcporterPath`
- `connectors.<provider>.enabled`
- `connectors.<provider>.baseUrl`
- `connectors.<provider>.apiKey`
- `connectors.<provider>.apiKeyHeader`
- `connectors.<provider>.apiKeyPrefix`
- `connectors.<provider>.mcporterRef`
- `connectors.<provider>.headers`

Use `financial_analysis_connectors` to:

- list configured connectors
- inspect connector status and auth readiness
- list remote MCP tools through `mcporter`
- call a selected remote MCP tool with JSON arguments

If a provider needs OAuth or a provider-specific auth flow, configure that server directly in `mcporter` first and set `connectors.<provider>.mcporterRef` to the existing server name. The extension will then call that named `mcporter` server instead of guessing auth headers itself.

The bridge stays explicit about endpoints, secrets, and provider-specific headers without assuming OpenClaw can consume the source `.mcp.json` file 1:1.

## Gaps

- PowerPoint/Excel automation remains skill-driven guidance rather than a new native runtime.
- The source repo's partner-built connector bundles are not included in this package.
- Inline connector mode still expects you to supply any provider-specific `apiKeyHeader`, `apiKeyPrefix`, or static `headers` values when you are not using `mcporterRef`.
