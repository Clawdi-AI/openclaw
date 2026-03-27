---
name: x-api-readonly
description: Use when you need read-only X (Twitter) data through Clawdi's billed proxy, including user lookup, tweets, replies, media, followers, following, lists, communities, and search timeline queries.
metadata:
  {
    "openclaw":
      {
        "emoji": "🐦",
        "requires": { "bins": ["curl"], "env": ["COMPOSIO_MCP_TOKEN"] },
      },
  }
---

# X API Read-Only

Use Clawdi's managed X proxy for read-only Twitter/X data.

- Fixed base URL: `https://api.clawdi.com/proxy/twitter`
- Auth header: `Authorization: Bearer $COMPOSIO_MCP_TOKEN`
- Do not send the upstream `token` query parameter yourself. The backend injects it.
- This skill is for Clawdi-managed deployments. If `COMPOSIO_MCP_TOKEN` is absent, the deployment is not provisioned for Clawdi-managed APIs.

## Operations

The proxy exposes these operations:

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

Optional pagination uses `cursor`. Forward it unchanged when the previous response includes one.

## Endpoint result roots

Use these root paths when reasoning about responses:

- `UserByScreenName`: `data.user.result`
- `UserTweets`: `data.user.result.timeline.timeline.instructions`
- `UserTweetsAndReplies`: `data.user.result.timeline.timeline.instructions`
- `UserMedia`: `data.user.result.timeline.timeline.instructions`
- `Followers`: `data.user.result.timeline.timeline.instructions`
- `Following`: `data.user.result.timeline.timeline.instructions`
- `SearchTimeline`: `data.search_by_raw_query.search_timeline.timeline.instructions`
- `TweetDetail`: `data.threaded_conversation_with_injections_v2.instructions`
- `ListLatestTweetsTimeline`: `data.list.tweets_timeline.timeline.instructions`
- `CommunityTweetsTimeline`: `data.communityResults.result.ranked_community_timeline.timeline.instructions`

## Parameter semantics

- `screenName`: X handle without the leading `@` unless the user explicitly includes it.
- `restId`: the internal X user or tweet identifier returned by prior calls. Do not guess it.
- `rawQuery`: the exact X search query string.
- `listId`: X list identifier.
- `communityId`: X community identifier.
- `cursor`: opaque pagination token from the previous response.
- `rankingMode`: observed on `CommunityTweetsTimeline`; use `Recency`. Omitting it still returns a timeline, but invalid values can produce a non-JSON `Error` response.

## Request patterns

Base pattern:

```bash
curl -sS --get \
  -H "Authorization: Bearer $COMPOSIO_MCP_TOKEN" \
  "https://api.clawdi.com/proxy/twitter/<OPERATION>"
```

## Usage

Prefer `curl --get --data-urlencode` so query values are encoded correctly and query composition is explicit.

```bash
curl -sS --get \
  -H "Authorization: Bearer $COMPOSIO_MCP_TOKEN" \
  --data-urlencode "screenName=openclaw" \
  "https://api.clawdi.com/proxy/twitter/UserByScreenName"
```

```bash
curl -sS --get \
  -H "Authorization: Bearer $COMPOSIO_MCP_TOKEN" \
  --data-urlencode "rawQuery=from:openclaw AI" \
  "https://api.clawdi.com/proxy/twitter/SearchTimeline"
```

```bash
curl -sS --get \
  -H "Authorization: Bearer $COMPOSIO_MCP_TOKEN" \
  --data-urlencode "restId=1234567890" \
  --data-urlencode "cursor=CURSOR_VALUE" \
  "https://api.clawdi.com/proxy/twitter/UserTweets"
```

## Workflow

### User-centric flow

1. If the user gives a handle, call `UserByScreenName` first.
2. Extract the returned user `restId`.
3. Reuse that `restId` for `UserTweets`, `UserTweetsAndReplies`, `Followers`, `Following`, or `UserMedia`.
4. When paginating, pass the returned `cursor` to the next call unchanged.

### Tweet-centric flow

1. If the user gives a tweet URL, extract the tweet ID from the `/status/<id>` segment.
2. Call `TweetDetail` with that ID as `restId`.
3. Use fields from the detail response to answer questions about the tweet, author, media, quoted tweet, or thread context.

### Search flow

1. Use `SearchTimeline` when the task is query-driven rather than user-driven.
2. Put the user intent into `rawQuery` directly using X search syntax such as `from:handle`, `to:handle`, `lang:en`, quoted phrases, or hashtags.
3. Preserve the raw JSON unless the user asks for a transformed result set.

## Capability mapping

- Look up a handle: `UserByScreenName`
- Get recent posts from a user: `UserTweets`
- Get recent posts including replies: `UserTweetsAndReplies`
- Inspect a specific post: `TweetDetail`
- Search public posts: `SearchTimeline`
- Get a user’s followers: `Followers`
- Get accounts a user follows: `Following`
- Get posts from a list: `ListLatestTweetsTimeline`
- Get posts from a community: `CommunityTweetsTimeline`
- Get a user’s media posts: `UserMedia`

## Observed output families

### User objects

Observed user payloads include:

- identity: `rest_id`, `core.name`, `core.screen_name`, `avatar.image_url`
- profile metadata: `legacy.description`, `location.location`, `professional`, `profile_image_shape`
- counts and status: `legacy.followers_count`, `legacy.friends_count`, `legacy.statuses_count`, `legacy.media_count`
- relationship/privacy: `relationship_perspectives`, `privacy`, `dm_permissions`
- verification-ish fields: `is_blue_verified`, `verification`, `verification_info`

`Followers` and `Following` return timeline entries whose `itemContent.itemType` is `TimelineUser`.

### Tweet objects

Observed tweet payloads include:

- core tweet id: `rest_id`
- author object under `core.user_results.result`
- raw post fields under `legacy`
- metrics under `legacy.favorite_count`, `legacy.reply_count`, `legacy.retweet_count`, and `views.count`
- edit metadata under `edit_control`
- rendered metadata such as `source`, `grok_analysis_button`, `is_translatable`

Observed special tweet variants across endpoints:

- quoted tweets: `quoted_status_result`
- long-form text: `note_tweet`
- cards/search enrichments: `card`, `quotedRefResult`, `grok_annotations`
- community-specific metadata: `community_results`, `community_relationship`, `author_community_relationship`

### Media

Observed media variants:

- `photo`
- `video`
- `animated_gif`

Media appears under `legacy.entities.media` and `legacy.extended_entities.media`. Videos include `video_info.variants` with multiple bitrate URLs.

## Pagination and traversal

- Most timeline endpoints return `Top` and `Bottom` cursors.
- `TweetDetail` also returns `ShowMore` and `ShowMoreThreads` cursors for deeper thread traversal.
- Reuse cursor values exactly; do not decode or modify them.
- For timeline endpoints, continue paging until the user’s goal is satisfied rather than assuming one page is enough.
- `Followers` and `Following` page over users, not tweets.

## Response handling

- Treat responses as authoritative JSON from the proxy.
- Preserve IDs, cursors, and query strings exactly for follow-up calls.
- If the user asks for analysis, summarize after reading the JSON rather than inventing fields.
- If a response contains nested instructionally useful IDs, surface them explicitly for later reuse.
- Expect timeline data to be nested inside `instructions`, `entries`, `items`, and `itemContent`; do not assume a flat `tweets[]` array.

## Error handling

- `400`: the request is malformed or missing the required parameter for that operation. Fix the call instead of retrying unchanged.
- `401`: the Clawdi-managed client token is missing or invalid.
- `402`: insufficient credits for the proxy call.
- `404`: unknown operation name.
- `5xx`: upstream or proxy failure; report it as service-side.
- Some upstream validation failures can return plain `Error` instead of structured JSON. Treat that as a caller-visible upstream error.

## Admin-only surface

- `tokenInfo` exists, but it is an admin/operational endpoint. Do not expose it to end users or treat it as part of the user-facing skill contract.

## Rules

- This proxy is read-only. Do not invent posting, liking, or follow-mutation commands.
- Do not include a `token` query parameter in requests.
- Do not invent undocumented operations outside the allowlisted set above.
- Use `UserByScreenName` before timeline/follower/media calls when you only have a handle.
- Keep IDs and cursors byte-for-byte unchanged when reusing them.
