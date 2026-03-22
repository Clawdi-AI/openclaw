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
  'toolkits=["<exact-toolkit-from-search>"]'
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

Google routing is inconsistent. Do not assume `googlesuper` covers every Google task.

When speaking to normal users:

- Treat this as "Google" from the user's perspective.
- If a task needs more access, say that some Google actions may need an additional Google sign-in or permission step.
- Offer the auth link plainly and tell the user you can continue right after they finish.
- Do not mention `googlesuper`, toolkit names, or Composio routing details unless the user asks for technical detail.

- You may try `googlesuper` in the search query for broad Google tasks.
- If search returns `GOOGLESUPER_*` tools and `toolkit_connection_statuses` only requires `googlesuper`, connect `googlesuper`.
- If search returns toolkit-specific Google tools like `GOOGLECALENDAR_*`, `GOOGLEDRIVE_*`, `GOOGLESHEETS_*`, or `GMAIL_*`, use the exact toolkit names returned by search when checking or creating connections.
- Do not map `googlecalendar`, `googledrive`, `googlesheets`, or `gmail` back to `googlesuper` on your own.
- Tool slugs and `toolkit_connection_statuses` are the source of truth.

Verified with live Composio MCP tests on 2026-03-22:

- `use googlesuper to send an email` returned `GOOGLESUPER_SEND_EMAIL`
- `use googlesuper to create a google calendar event` returned `GOOGLESUPER_CREATE_EVENT`
- `use googlesuper to list files in google drive` still returned mixed `googledrive` and `googlesuper`
- `use googlesuper to create a row in google sheets` still returned `GOOGLESHEETS_*`

Composio-managed auth configs for `googlesuper`, `googlecalendar`, `googledrive`, `googlesheets`, and `gmail` are distinct, so substituting one toolkit for another is unsafe unless search explicitly does it for you.

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
- Check connection status before executing and use the exact toolkit names returned by search.
- Use `recommended_plan_steps`.
- Read `known_pitfalls`.
- Loop on pagination when `has_more` is true.
- Group independent actions into one `COMPOSIO_MULTI_EXECUTE_TOOL` call.
- Confirm with the user before side-effecting operations like sending email or creating issues.
