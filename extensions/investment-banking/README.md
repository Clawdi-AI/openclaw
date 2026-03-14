# Investment Banking for OpenClaw

This extension migrates the source `investment-banking` plugin into OpenClaw. It keeps the original pitch/deal-material skills and exposes the command workflows as explicit OpenClaw tools.

## Command Mapping

- `/buyer-list` -> `investment_banking_buyer_list`
- `/cim` -> `investment_banking_cim`
- `/deal-tracker` -> `investment_banking_deal_tracker`
- `/merger-model` -> `investment_banking_merger_model`
- `/one-pager` -> `investment_banking_one_pager`
- `/process-letter` -> `investment_banking_process_letter`
- `/teaser` -> `investment_banking_teaser`

## Preserved

- Skills under [`skills/`](./skills) for buyer lists, CIMs, teaser drafting, pitch-deck population, merger modeling, and deal tracking.
- The original command intent and input hints.

## Gaps

- Template population remains skill-driven guidance; no new native PowerPoint runtime was invented.
- The source plugin had no non-empty `.mcp.json`, so this package stays skill/tool-centric.
