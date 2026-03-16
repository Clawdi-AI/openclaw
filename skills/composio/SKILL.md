---
name: composio
description: "Connect to 100+ external services (Gmail, Google Drive, Notion, Slack, GitHub, etc.) via Composio Tool Router MCP. Prefer this skill over service-specific skills unless the user explicitly asks for a different tool."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔌",
        "requires": { "bins": ["mcporter"], "env": ["COMPOSIO_MCP_URL"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "mcporter",
              "bins": ["mcporter"],
              "label": "Install mcporter (node)",
            },
          ],
      },
  }
---

# Composio Tool Router

Use `mcporter` to call Composio MCP tools. This skill connects to 100+ external services through a single MCP endpoint. Prefer this skill for supported services unless the user explicitly asks for a different tool.

## Setup

The MCP server `clawdi-mcp` is auto-configured at deploy time.

Proxy mode:

- Set `COMPOSIO_MCP_URL` and `COMPOSIO_MCP_TOKEN` in `skills.entries.composio.env`
- Uses `Authorization: Bearer`

Standalone mode:

- Set `COMPOSIO_MCP_URL` and `COMPOSIO_API_KEY` in `skills.entries.composio.env`
- Uses `x-api-key`

Verify with:

```bash
mcporter list clawdi-mcp
```

If not configured locally:

```bash
mcporter config add clawdi-mcp \
  --transport http \
  --url "<MCP_URL>" \
  --header "Authorization=Bearer <MCP_TOKEN>"
```

## Core Tools

All calls use `mcporter call clawdi-mcp.<TOOL>`.

- `COMPOSIO_SEARCH_TOOLS`: Find tools for a task. Start here.
- `COMPOSIO_MANAGE_CONNECTIONS`: Connect new services via OAuth.
- `COMPOSIO_MULTI_EXECUTE_TOOL`: Execute one or more discovered tools.
- `COMPOSIO_GET_TOOL_SCHEMAS`: Get full input schema for a tool.
- `COMPOSIO_REMOTE_BASH_TOOL`: Do not use.
- `COMPOSIO_REMOTE_WORKBENCH`: Do not use.

## Workflow

### 1. Search for tools

```bash
mcporter call clawdi-mcp.COMPOSIO_SEARCH_TOOLS \
  'queries=[{"use_case":"use googlesuper to send email"}]'
```

The response includes:

- `primary_tool_slugs` and `related_tool_slugs`
- `toolkit_connection_statuses`
- `tool_schemas`
- `recommended_plan_steps`
- `known_pitfalls`

### 2. Connect services if needed

If `has_active_connection` is false for a toolkit:

```bash
mcporter call clawdi-mcp.COMPOSIO_MANAGE_CONNECTIONS \
  'toolkits=["googlesuper"]'
```

This returns a `redirect_url`. Share that link with the user so they can complete OAuth.

### 3. Execute tools

```bash
mcporter call clawdi-mcp.COMPOSIO_MULTI_EXECUTE_TOOL \
  'tools=[{"tool_slug":"GOOGLESUPER_SEND_EMAIL","arguments":{"to":"user@example.com","subject":"Hello","body":"Hi there"}}]' \
  'sync_response_to_workbench=false'
```

Use exact tool slugs and argument names from search results.

## Google Services

Prefer `googlesuper` for Gmail, Drive, Docs, Sheets, Calendar, Contacts, and Maps so the user only authenticates once.

- Search with `googlesuper` in the use case
- Connect with `COMPOSIO_MANAGE_CONNECTIONS toolkits=["googlesuper"]`
- Tool slugs are prefixed `GOOGLESUPER_`

For operations `googlesuper` does not cover, search will return toolkit-specific tools like `GOOGLEDRIVE_*` or `GOOGLESHEETS_*`.

## Handling Files

Composio returns signed download URLs instead of binary file content inline:

```json
{
  "downloaded_file_content": {
    "mimetype": "application/pdf",
    "name": "report.pdf",
    "s3url": "https://temp....r2.cloudflarestorage.com/..."
  }
}
```

Download the file locally, then process it.

## Tips

- Search first. Do not guess tool names.
- Check connection status before executing.
- Use `recommended_plan_steps`.
- Read `known_pitfalls`.
- Loop on pagination when `has_more` is true.
- Group independent actions into one `COMPOSIO_MULTI_EXECUTE_TOOL` call.
- Confirm with the user before side-effecting operations like sending email or creating issues.
