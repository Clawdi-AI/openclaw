# Equity Research for OpenClaw

This extension migrates the source `equity-research` plugin into OpenClaw. It preserves the original report-writing and monitoring skills while converting the source slash commands into explicit OpenClaw workflow tools.

## Command Mapping

- `/catalysts` -> `equity_research_catalysts`
- `/earnings-preview` -> `equity_research_earnings_preview`
- `/earnings` -> `equity_research_earnings`
- `/initiate` -> `equity_research_initiate`
- `/model-update` -> `equity_research_model_update`
- `/morning-note` -> `equity_research_morning_note`
- `/screen` -> `equity_research_screen`
- `/sector` -> `equity_research_sector`
- `/thesis` -> `equity_research_thesis`

## Preserved

- Skills under [`skills/`](./skills) for earnings work, initiation reports, sector work, catalyst tracking, and idea generation.
- The source plugin's original input hints and research-oriented workflow steps.

## Gaps

- No direct MCP connector layer was present in the source plugin, so the migration stays skill-first.
- The add-on remains workflow guidance plus agent tools, not a deterministic report generator.
