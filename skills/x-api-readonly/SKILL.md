---
name: x-api-readonly
description: Use when you need read-only X (Twitter) data through Clawdi's billed proxy, including user lookup, tweets, replies, media, followers, following, lists, communities, and search timeline queries.
metadata:
  {
    "openclaw":
      {
        "emoji": "🐦",
        "primaryEnv": "X_API_TOKEN",
        "requires": { "bins": ["curl"], "env": ["X_API_BASE_URL", "X_API_TOKEN"] },
      },
  }
---

# X API

Use Clawdi's X proxy for read-only Twitter/X data. Authenticate with `Authorization: Bearer $X_API_TOKEN`. Do not send the upstream `token` query parameter yourself; the backend injects it.

## Operations

The proxy exposes these operations under `$X_API_BASE_URL/{operation}`:

- `UserByScreenName` with `screenName`
- `UserTweets` with `restId`
- `UserTweetsAndReplies` with `restId`
- `SearchTimeline` with `rawQuery`
- `TweetDetail` with `restId`
- `Followers` with `restId`
- `Following` with `restId`
- `ListLatestTweetsTimeline` with `listId`
- `CommunityTweetsTimeline` with `communityId`
- `UserMedia` with `restId`

Optional pagination uses `cursor`.

## Usage

Prefer `curl --get --data-urlencode` so query values are encoded correctly.

```bash
curl -sS --get \
  -H "Authorization: Bearer $X_API_TOKEN" \
  --data-urlencode "screenName=openclaw" \
  "$X_API_BASE_URL/UserByScreenName"
```

```bash
curl -sS --get \
  -H "Authorization: Bearer $X_API_TOKEN" \
  --data-urlencode "rawQuery=from:openclaw AI" \
  "$X_API_BASE_URL/SearchTimeline"
```

```bash
curl -sS --get \
  -H "Authorization: Bearer $X_API_TOKEN" \
  --data-urlencode "restId=1234567890" \
  --data-urlencode "cursor=CURSOR_VALUE" \
  "$X_API_BASE_URL/UserTweets"
```

## Workflow

1. Resolve the user with `UserByScreenName` when you only have a handle.
2. Reuse the returned `restId` for user timeline, replies, followers, following, and media calls.
3. Use `TweetDetail` when the user gives a tweet URL or tweet ID.
4. Keep results as JSON unless the user explicitly asks for transformation or summarization.

## Rules

- This proxy is read-only. Do not invent posting, liking, or follow-mutation commands.
- Do not include a `token` query parameter in requests.
- Treat 402 as insufficient credits and surface that clearly.
- Treat 404 on unknown operations or 400 on missing required params as caller errors and fix the request instead of retrying unchanged.
