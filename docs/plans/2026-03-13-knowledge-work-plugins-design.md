# Knowledge-Work Plugin Converter for OpenClaw

## Goal

Convert Anthropic's [knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) (built for Claude Cowork/Code) into OpenClaw skills, starting with the **sales** and **marketing** plugins. Use mcporter/Composio/native skills as the tool backend, with a hook-injected connector mapping to resolve `~~category` placeholders.

## Architecture Overview

```
extensions/work-connectors/          <- plugin: injects connector resolution into prompt
  index.ts                           <- before_prompt_build hook
  connectors.json                    <- single source of truth for ~~category mappings
  openclaw.plugin.json
  package.json

skills/sales-*/SKILL.md             <- converted sales skills
skills/marketing-*/SKILL.md         <- converted marketing skills

scripts/convert-knowledge-work.ts   <- converter script
```

## Layer 1: work-connectors Extension

A lightweight OpenClaw plugin that reads `connectors.json` once at startup and injects the connector resolution table into every prompt via the `before_prompt_build` hook.

### connectors.json (user-editable, single source of truth)

```json
{
  "connectors": {
    "~~crm":         { "backend": "composio", "ref": "clawdi-mcp.HUBSPOT_*" },
    "~~chat":        { "backend": "skill",    "ref": "slack" },
    "~~email":       { "backend": "composio", "ref": "clawdi-mcp.GOOGLESUPER_*" },
    "~~enrichment":  { "backend": "mcporter", "ref": "zoominfo" },
    "~~docs":        { "backend": "composio", "ref": "clawdi-mcp.NOTION_*" },
    "~~tracker":     { "backend": "composio", "ref": "clawdi-mcp.LINEAR_*" },
    "~~calendar":    { "backend": "composio", "ref": "clawdi-mcp.GOOGLESUPER_*" },
    "~~analytics":   { "backend": "mcporter", "ref": "amplitude" },
    "~~design":      { "backend": "mcporter", "ref": "figma" },
    "~~calls":       { "backend": "mcporter", "ref": "fireflies" }
  }
}
```

### Hook behavior

- Reads `connectors.json` at startup, caches in memory
- On `before_prompt_build`, returns the mapping as `prependContext`
- Always injected (~500 chars, negligible context cost)
- If connectors.json is missing or empty, injects nothing

### Injected prompt format

```
## Connector Resolution
When a skill references a ~~category, use this mapping:
- ~~crm: use composio (clawdi-mcp.HUBSPOT_*)
- ~~chat: use the slack skill
- ~~email: use composio (clawdi-mcp.GOOGLESUPER_*)
...
If a connector is listed as "skill:<name>", use that OpenClaw skill's actions directly.
If a connector is listed as "mcporter", use: mcporter call <ref>.<tool_name> key=value
If a connector is listed as "composio", use the composio skill workflow (search -> connect -> execute).
If a ~~category has no mapping configured, tell the user what to add to connectors.json.
```

## Layer 2: Converted Skills

### Naming convention

Flat namespace with prefix: `skills/<plugin>-<skill-name>/SKILL.md`

### Sales skills (7)

| Skill | Source | Lobster? |
|-------|--------|----------|
| `sales-account-research` | `sales/skills/account-research` | No |
| `sales-call-prep` | `sales/skills/call-prep` | No |
| `sales-competitive-intel` | `sales/skills/competitive-intelligence` | No |
| `sales-create-asset` | `sales/skills/create-an-asset` | No |
| `sales-daily-briefing` | `sales/skills/daily-briefing` | No |
| `sales-draft-outreach` | `sales/skills/draft-outreach` | No |
| `sales-pipeline-review` | `sales/commands/pipeline-review` + `sales/commands/forecast` | Yes |

### Marketing skills (estimated from plugin)

Exact list determined during conversion. Expected 5-7 skills following the same pattern.

### Skill template

```markdown
---
name: sales-account-research
description: Research a company or person before a sales call using CRM history, enrichment data, and web search. Use when asked to look up, research, or get intel on an account, company, or contact. NOT for drafting outreach or creating assets.
metadata: { "openclaw": { "emoji": "🔍" } }
---

# Account Research

## When to use
- "Research Stripe"
- "Look up the CTO at Notion"
- "Intel on acme.com before my call"

## Steps
1. Collect the target: company name, person name, or domain
2. Run web search for recent news, press releases, and background
3. Pull account/contact history from ~~crm (if available)
4. Fetch enrichment data from ~~enrichment (if available)
5. Compile into the research brief format below

## Output Format
[structured template from the original skill]
```

### Description engineering rules

Descriptions must:
- State what the skill does in one sentence
- Include 2-3 positive trigger phrases ("Use when...")
- Include explicit exclusions ("NOT for...")
- Avoid `~~` syntax (plain language only in descriptions)
- Be distinct from every other skill's description

### Lobster usage policy

Only embed Lobster workflows in skills that meet ALL of these criteria:
1. Multi-step data pipeline (not just AI-guided instructions)
2. Deterministic execution needed (same input -> same output)
3. Approval gate makes sense (user should review before acting)

Expected Lobster skills: `sales-pipeline-review` (2-3 total across both plugins). All other skills are pure AI-guided workflows with no Lobster dependency.

Skills with Lobster must declare: `"requires": { "bins": ["lobster"] }`

## Layer 3: Converter Script

`scripts/convert-knowledge-work.ts`

### Usage

```bash
node --import tsx scripts/convert-knowledge-work.ts \
  --input ../knowledge-work-plugins/sales \
  --prefix sales
```

### Steps

1. **Parse metadata**: read `.claude-plugin/plugin.json` for plugin name/description
2. **Extract connectors**: read `.mcp.json`, map server names to `~~category`, merge into `connectors.json`
3. **Convert skills**: for each `skills/*/SKILL.md`:
   - Transform YAML frontmatter to OpenClaw format
   - Preserve `~~category` references in the body
   - Fold QUICKREF.md content into the SKILL.md (OpenClaw only reads SKILL.md)
   - Rewrite description for precision (positive triggers + exclusions)
   - Write to `skills/<prefix>-<name>/SKILL.md`
4. **Convert commands**: for each `commands/*.md`:
   - If multi-step deterministic pipeline: generate skill with embedded Lobster workflow
   - If AI-guided workflow: generate skill with step-by-step instructions
   - Write to `skills/<prefix>-<name>/SKILL.md`
5. **Report**: log what was converted, connectors added, manual steps needed

### MCP server to ~~category mapping heuristic

| MCP server name | ~~category |
|-----------------|-----------|
| hubspot, close, salesforce | ~~crm |
| slack | ~~chat |
| ms365, gmail | ~~email |
| notion, atlassian, guru | ~~docs |
| zoominfo, clay | ~~enrichment |
| linear, asana, monday, clickup | ~~tracker |
| amplitude, pendo | ~~analytics |
| figma, canva | ~~design |
| fireflies | ~~calls |

Unknown servers are logged as warnings for manual categorization.

## Design Decisions

### Why hook injection over a connector resolution skill?
- Zero hops for the AI (connector mapping is already in context)
- No file-lookup indirection that could fail
- Single source of truth, no duplication across skills

### Why always-inject over conditional injection?
- ~500 chars is negligible in a 30,000 char skill prompt budget
- Conditional injection requires knowing which skills will activate before they activate
- Simpler = more reliable

### Why flat naming (`sales-*`) over nested directories?
- Matches existing OpenClaw convention (60+ skills all use flat naming)
- Avoids custom skill discovery logic
- Clearer in skill listings

### Why selective Lobster over Lobster-everywhere?
- Most knowledge-work workflows are AI-guided (the LLM interprets and adapts)
- Lobster adds a binary dependency and is overkill for "gather info, write a brief"
- Reserve Lobster for truly deterministic data pipelines with approval gates

### Why keep `~~` syntax?
- Mechanical conversion from knowledge-work plugins (less error-prone)
- Familiar to anyone coming from that ecosystem
- Clean separation: skills say WHAT connector to use, connectors.json says HOW

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Skill misrouting (AI picks wrong skill) | High | Precise descriptions with positive triggers + exclusions |
| Lobster not installed | Medium | Only 2-3 skills require it; `requires.bins` check filters them |
| MCP server auth failures | Medium | Connector mapping tells user what to configure; composio handles OAuth |
| Upstream plugin format changes | Low | One-time converter; not a live integration |
| Context window bloat from connector injection | Low | ~500 chars; well within 30K budget |
