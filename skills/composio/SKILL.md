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
- a short workflow `session.id`; pass it to later meta-tool calls when provided

### Connection model

Use this skill as toolkit-level connection management.

- Assume one usable active account per toolkit from MCP's perspective.
- Unless the execution tool schema explicitly exposes account switching, do not tell the user they can choose between multiple accounts for the same toolkit through MCP. Google toolkits do not support account switching.
- `COMPOSIO_MANAGE_CONNECTIONS` is for checking, connecting, or reconnecting toolkits, not for selecting individual accounts.
- If a toolkit is already active, calling `COMPOSIO_MANAGE_CONNECTIONS` again usually returns the existing active connection instead of a second-account OAuth link.
- If the user explicitly wants to switch the active account for a toolkit, reconnect that toolkit with `reinitiate_all=true` and explain that MCP will reconnect the toolkit rather than let them pick from multiple existing accounts.

### 2. Connect services if needed

If `has_active_connection` is false for a toolkit:

```bash
mcporter call clawdi-mcp.COMPOSIO_MANAGE_CONNECTIONS \
  'toolkits=["<exact-toolkit-from-search>"]' \
  'session_id="star"'
```

This returns a `redirect_url`. Share that link with the user so they can complete OAuth.

If `has_active_connection` is true, do not try to use `COMPOSIO_MANAGE_CONNECTIONS` to add a second account for that same toolkit. MCP generally treats the toolkit as already connected. If the user explicitly wants to replace or refresh the active account, use:

```bash
mcporter call clawdi-mcp.COMPOSIO_MANAGE_CONNECTIONS \
  'toolkits=["gmail"]' \
  'reinitiate_all=true'
```

Explain clearly that MCP will reconnect the toolkit, not let the user pick between multiple existing accounts.

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
- If the user asks to connect a second account for the same toolkit, warn that MCP is single-account-oriented from the agent's perspective and cannot target a specific account unless the execution schema explicitly supports switching.
- Use `recommended_plan_steps`.
- Read `known_pitfalls`.
- Loop on pagination when `has_more` is true.
- Group independent actions into one `COMPOSIO_MULTI_EXECUTE_TOOL` call.
- Confirm with the user before side-effecting operations like sending email or creating issues.
