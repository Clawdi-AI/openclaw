# Private Equity for OpenClaw

This extension migrates the source `private-equity` plugin into OpenClaw. It keeps the original diligence, sourcing, portfolio-monitoring, and value-creation skills while exposing the command workflows as OpenClaw tools.

## Command Mapping

- `/ai-readiness` -> `private_equity_ai_readiness`
- `/dd-checklist` -> `private_equity_dd_checklist`
- `/dd-prep` -> `private_equity_dd_prep`
- `/ic-memo` -> `private_equity_ic_memo`
- `/portfolio` -> `private_equity_portfolio`
- `/returns` -> `private_equity_returns`
- `/screen-deal` -> `private_equity_screen_deal`
- `/source` -> `private_equity_source`
- `/unit-economics` -> `private_equity_unit_economics`
- `/value-creation` -> `private_equity_value_creation`

## Preserved

- Skills under [`skills/`](./skills) for sourcing, screening, diligence, returns, and portfolio monitoring.
- The source plugin's workflow prompts and argument hints.

## Gaps

- The original source command mentions CRM-aware sourcing; this migration preserves the workflow guidance but does not invent a CRM client.
- No live connector layer existed in the source plugin, so the package remains skill-driven.
