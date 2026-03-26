---
name: tavily
description: AI-optimized web search and content extraction via the Tavily API. Use when the user asks to search the web, find current information, research a topic, look up recent news, or retrieve structured content from URLs. Returns clean, relevant excerpts designed for AI agents — no scraping noise. Triggers on phrases like "search the web", "find recent info on", "look up", "what's the latest on", "research X".
metadata:
  {
    "openclaw":
      {
        "emoji": "🔍",
        "primaryEnv": "TAVILY_API_KEY",
        "requires": { "env": ["TAVILY_API_KEY"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "tavily-mcp",
              "bins": ["tavily-mcp"],
              "label": "Install Tavily MCP server (npm)",
            },
          ],
      },
  }
---

# Tavily Web Search

AI-optimized search API returning structured, agent-ready results.

Auth: set `TAVILY_API_KEY` environment variable.

## Search

```bash
curl -s -X POST https://api.tavily.com/search \
  -H "Content-Type: application/json" \
  -d "{
    \"api_key\": \"$TAVILY_API_KEY\",
    \"query\": \"your query here\",
    \"search_depth\": \"basic\",
    \"max_results\": 5,
    \"include_answer\": true
  }" | jq .
```

## Key parameters

| Parameter             | Values               | Notes                                 |
| --------------------- | -------------------- | ------------------------------------- |
| `search_depth`        | `basic` / `advanced` | `advanced` fetches full page content  |
| `max_results`         | 1–20                 | Default 5                             |
| `include_answer`      | bool                 | AI-synthesized one-line answer        |
| `include_raw_content` | bool                 | Full extracted page text              |
| `topic`               | `general` / `news`   | `news` for recent articles            |
| `include_domains`     | string[]             | Restrict to these domains             |
| `exclude_domains`     | string[]             | Skip these domains                    |
| `days`                | number               | News recency filter (topic=news only) |

## Response shape

```json
{
  "answer": "...",
  "results": [{ "url": "...", "title": "...", "content": "...", "score": 0.95 }]
}
```

## Tips

- Use `topic: "news"` + `days: 3` for breaking news or recent events.
- Use `search_depth: "advanced"` when you need full article text.
- `include_answer: true` gives a fast one-liner for simple factual queries.
- Combine `include_answer` + top results for confident, cited responses.
