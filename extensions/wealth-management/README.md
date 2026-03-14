# Wealth Management for OpenClaw

This extension migrates the source `wealth-management` plugin into OpenClaw. It preserves the original advisory workflow skills and turns the source slash commands into explicit OpenClaw workflow tools.

## Command Mapping

- `/client-report` -> `wealth_management_client_report`
- `/client-review` -> `wealth_management_client_review`
- `/financial-plan` -> `wealth_management_financial_plan`
- `/proposal` -> `wealth_management_proposal`
- `/rebalance` -> `wealth_management_rebalance`
- `/tlh` -> `wealth_management_tlh`

## Preserved

- Skills under [`skills/`](./skills) for review prep, planning, proposals, rebalancing, and reporting.
- The original client- and account-oriented workflow guidance.

## Gaps

- No live portfolio-system or custodial integration existed in the source plugin, so the migration remains skill/tool-centric.
