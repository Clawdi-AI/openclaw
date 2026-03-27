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

This skill is a detailed manual for Clawdi's managed read-only X proxy.

Use it when the task requires reading X users, tweets, replies, media, lists, communities, search results, followers, or following relationships. Do not use it for posting, liking, following, bookmarks, DMs, or any admin/operational surface.

## Contract

- Base URL is fixed: `https://api.clawdi.com/proxy/twitter`
- Auth header is fixed: `Authorization: Bearer $COMPOSIO_MCP_TOKEN`
- All requests are `GET`
- All supported operations are allowlisted by the gateway
- The upstream `token` query parameter is injected by the backend; never send it yourself
- The API is read-only from the agent's perspective

If `COMPOSIO_MCP_TOKEN` is absent, this deployment is not provisioned for Clawdi-managed APIs and the skill should not be used.

## Supported operations

| Operation | Required input | Primary use |
| --- | --- | --- |
| `UserByScreenName` | `screenName` | Resolve a handle to a user object and `rest_id` |
| `UserTweets` | `restId` | Get a user's recent tweets |
| `UserTweetsAndReplies` | `restId` | Get a user's recent tweets plus replies |
| `SearchTimeline` | `rawQuery` | Run an X search query |
| `TweetDetail` | `restId` | Inspect a tweet and its thread context |
| `Followers` | `restId` | Page through follower users |
| `Following` | `restId` | Page through following users |
| `ListLatestTweetsTimeline` | `listId` | Get latest tweets from a list |
| `CommunityTweetsTimeline` | `communityId` | Get latest community tweets |
| `UserMedia` | `restId` | Get a user's media tweets |

Optional pagination uses `cursor`.

Observed special case:

- `CommunityTweetsTimeline` accepts `rankingMode=Recency`
- Omitting `rankingMode` still returns a timeline
- Invalid `rankingMode` can return a plain `Error`
- Use `Recency` unless future gateway docs say otherwise

## Input semantics

### `screenName`

- X handle
- Usually pass it without the leading `@`
- If the user types `@handle`, strip the `@` before sending

### `restId`

This API uses `restId` for more than one logical type:

- user id for user-centric endpoints: `UserTweets`, `UserTweetsAndReplies`, `Followers`, `Following`, `UserMedia`
- tweet id for `TweetDetail`

Never guess a `restId`. Get it from:

- `UserByScreenName` for users
- a tweet URL `/status/<id>` for tweet detail
- prior response payloads

### `rawQuery`

Pass the exact X search query string. This is not a normalized JSON filter language. It is closer to native X search syntax.

Useful patterns include:

- `from:handle`
- `to:handle`
- quoted phrases
- hashtags
- `lang:en`

### `cursor`

- Opaque pagination token
- Comes from the previous response
- Must be reused byte-for-byte
- Do not decode, trim, or normalize it

### `listId`

- X list identifier
- Treat as opaque

### `communityId`

- X community identifier
- Treat as opaque

## Request patterns

### Base form

```bash
curl -sS --get \
  -H "Authorization: Bearer $COMPOSIO_MCP_TOKEN" \
  "https://api.clawdi.com/proxy/twitter/<OPERATION>"
```

### Recommended form with query encoding

Always prefer `--data-urlencode` for user-provided query values.

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
  --data-urlencode "restId=1212607092600606722" \
  --data-urlencode "cursor=CURSOR_VALUE" \
  "https://api.clawdi.com/proxy/twitter/UserTweets"
```

```bash
curl -sS --get \
  -H "Authorization: Bearer $COMPOSIO_MCP_TOKEN" \
  --data-urlencode "communityId=1499359436388782087" \
  --data-urlencode "rankingMode=Recency" \
  "https://api.clawdi.com/proxy/twitter/CommunityTweetsTimeline"
```

## Endpoint selection guide

### If the user gives a handle

1. Call `UserByScreenName`
2. Extract `data.user.result.rest_id`
3. Reuse that `rest_id` for:
   - `UserTweets`
   - `UserTweetsAndReplies`
   - `Followers`
   - `Following`
   - `UserMedia`

### If the user gives a tweet URL or tweet id

1. Extract the numeric tweet id from the URL if needed
2. Call `TweetDetail` with that id as `restId`
3. Use the returned thread structure to inspect:
   - the target tweet
   - replies in the thread
   - quoted tweet references
   - media
   - continuation cursors

### If the user gives a query

Use `SearchTimeline`.

Do not first resolve a user unless the query task specifically becomes user-centric after the initial search.

### If the task is "show a user's posts"

- use `UserTweets` for tweets only
- use `UserTweetsAndReplies` for tweets plus replies
- use `UserMedia` for media-heavy posts

### If the task is "who follows whom"

- use `Followers` to get followers of the target user
- use `Following` to get accounts the target user follows

### If the task is list or community centric

- use `ListLatestTweetsTimeline` for list ids
- use `CommunityTweetsTimeline` for community ids

## Result roots by endpoint

These are the stable roots to start from. Do not assume a flat array anywhere.

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

## Traversal model

Most timeline-style endpoints are nested like this:

1. response root
2. `instructions`
3. instruction with `type == "TimelineAddEntries"`
4. `entries`
5. `content`
6. one of:
   - tweet item
   - user item
   - cursor item
   - timeline module containing nested tweet items

Never assume:

- a top-level `tweets` array
- a top-level `users` array
- that every entry is a tweet
- that every entry is a final content item rather than a wrapper/module/cursor

## Common content variants

### Tweet item

Typical shape:

```json
{
  "content": {
    "entryType": "TimelineTimelineItem",
    "itemContent": {
      "__typename": "TimelineTweet",
      "itemType": "TimelineTweet",
      "tweetDisplayType": "Tweet",
      "tweet_results": {
        "result": {
          "__typename": "Tweet",
          "rest_id": "2032415448755822937",
          "core": {
            "user_results": {
              "result": {
                "__typename": "User",
                "rest_id": "1212607092600606722",
                "core": {
                  "name": "Limichange",
                  "screen_name": "Limichange2"
                }
              }
            }
          },
          "legacy": {
            "full_text": "native https://t.co/...",
            "created_at": "Fri Mar 13 11:16:18 +0000 2026",
            "conversation_id_str": "2032415448755822937",
            "favorite_count": 4,
            "reply_count": 3,
            "retweet_count": 0
          },
          "views": {
            "count": "2834"
          }
        }
      }
    }
  }
}
```

### User item

Typical shape from `Followers` / `Following`:

```json
{
  "content": {
    "entryType": "TimelineTimelineItem",
    "itemContent": {
      "__typename": "TimelineUser",
      "itemType": "TimelineUser",
      "userDisplayType": "User",
      "user_results": {
        "result": {
          "__typename": "User",
          "rest_id": "1581259092928040961",
          "core": {
            "name": "尹珉",
            "screen_name": "yinmin1987"
          },
          "legacy": {
            "followers_count": 4781,
            "friends_count": 3871,
            "media_count": 847,
            "statuses_count": 5524
          }
        }
      }
    }
  }
}
```

### Cursor item

Typical shape:

```json
{
  "content": {
    "entryType": "TimelineTimelineCursor",
    "cursorType": "Bottom",
    "value": "DAAHCgAB..."
  }
}
```

### Tweet detail thread item

Typical shape:

```json
{
  "data": {
    "threaded_conversation_with_injections_v2": {
      "instructions": [
        {
          "type": "TimelineAddEntries",
          "entries": [
            {
              "content": {
                "entryType": "TimelineTimelineItem",
                "itemContent": {
                  "__typename": "TimelineTweet",
                  "tweet_results": {
                    "result": {
                      "__typename": "Tweet",
                      "rest_id": "1897289524193214579",
                      "legacy": {
                        "full_text": "...",
                        "conversation_id_str": "1897289524193214579"
                      }
                    }
                  }
                }
              }
            },
            {
              "content": {
                "entryType": "TimelineTimelineCursor",
                "cursorType": "ShowMoreThreads",
                "value": "DAAKCgAB..."
              }
            }
          ]
        }
      ]
    }
  }
}
```

## Observed object families

### User object family

Observed user objects include:

- identity:
  - `rest_id`
  - `core.name`
  - `core.screen_name`
  - `avatar.image_url`
- profile:
  - `legacy.description`
  - `location.location`
  - `professional`
  - `profile_image_shape`
- counts:
  - `legacy.followers_count`
  - `legacy.friends_count`
  - `legacy.statuses_count`
  - `legacy.media_count`
- relationship/privacy:
  - `relationship_perspectives`
  - `privacy`
  - `dm_permissions`
- verification-ish fields:
  - `is_blue_verified`
  - `verification`
  - `verification_info`

### Tweet object family

Observed tweet objects include:

- id and author:
  - `rest_id`
  - `core.user_results.result`
- raw tweet payload:
  - `legacy`
- metrics:
  - `legacy.favorite_count`
  - `legacy.reply_count`
  - `legacy.retweet_count`
  - `views.count`
- rendering/state:
  - `source`
  - `is_translatable`
  - `edit_control`
  - `grok_analysis_button`

Observed special tweet variants:

- quoted tweets:
  - `quoted_status_result`
- long-form note tweets:
  - `note_tweet`
- search/list enrichments:
  - `card`
  - `quotedRefResult`
  - `grok_annotations`
- community-specific fields:
  - `community_results`
  - `community_relationship`
  - `author_community_relationship`

### Media family

Observed media variants:

- `photo`
- `video`
- `animated_gif`

Media usually appears under:

- `legacy.entities.media`
- `legacy.extended_entities.media`

Video payloads can include:

- `media_url_https`
- `video_info.duration_millis`
- `video_info.variants[]`

## Endpoint-specific notes

### `UserByScreenName`

Best for:

- turning a handle into a stable `rest_id`
- getting a profile summary
- retrieving follower/friend/status/media counts before deeper traversal

Important outputs:

- `rest_id`
- `core.name`
- `core.screen_name`
- `legacy.description`
- `legacy.followers_count`
- `legacy.friends_count`
- `legacy.statuses_count`
- `legacy.media_count`

### `UserTweets`

Best for:

- recent tweets without reply noise

Observed behavior:

- can include pinned tweet handling
- can include timeline modules, not just flat tweet items
- returns `Top` and `Bottom` cursors

### `UserTweetsAndReplies`

Best for:

- understanding how a user is interacting, not just what they broadcast

Observed behavior:

- same general shape as `UserTweets`
- includes reply/conversation material
- can contain quoted tweets and note tweets

### `SearchTimeline`

Best for:

- query-driven tasks
- topical discovery
- finding recent relevant tweets when you do not already know the author

Observed behavior:

- root differs from user timelines
- results still use nested timeline entries
- supports quoted tweets, cards, and search enrichments

### `TweetDetail`

Best for:

- one specific tweet
- thread traversal
- finding quoted tweet context
- getting thread continuation cursors

Observed behavior:

- returns `ShowMore` and `ShowMoreThreads` cursors in addition to entry items
- structure is thread-centric, not user-centric

### `Followers` and `Following`

Best for:

- relationship inspection
- community/account graph exploration

Observed behavior:

- page over `TimelineUser`, not `TimelineTweet`
- still use nested timeline instructions and cursors

### `ListLatestTweetsTimeline`

Best for:

- monitoring a curated list feed

Observed behavior:

- timeline shape is tweet-centric
- can include cards, quoted tweets, and media

### `CommunityTweetsTimeline`

Best for:

- community feed exploration

Observed behavior:

- community-specific fields exist on tweet objects
- `rankingMode=Recency` works
- invalid ranking values can produce non-JSON `Error`

### `UserMedia`

Best for:

- finding a user's media-heavy tweets
- retrieving video/photo/gif posts

Observed behavior:

- can use `tweetDisplayType = MediaGrid`
- strong presence of media metadata

## Pagination rules

- Most timeline endpoints return `Top` and `Bottom` cursors
- `TweetDetail` additionally returns `ShowMore` and `ShowMoreThreads`
- Reuse cursor values exactly as returned
- Do not decode or normalize cursor strings
- Stop paging when:
  - the user goal is satisfied
  - the next page no longer contributes relevant results
  - no new bottom cursor appears

## Extraction recipes

### Recipe: handle -> user id -> recent tweets

1. `UserByScreenName(screenName)`
2. read `data.user.result.rest_id`
3. call `UserTweets(restId)`
4. traverse timeline entries to extract `tweet_results.result`

### Recipe: handle -> followers

1. `UserByScreenName(screenName)`
2. read `data.user.result.rest_id`
3. call `Followers(restId)`
4. traverse timeline entries to extract `user_results.result`
5. if needed, page with bottom cursor

### Recipe: tweet URL -> thread

1. parse numeric id from `/status/<id>`
2. call `TweetDetail(restId=<tweet id>)`
3. extract the primary tweet and any additional thread items
4. if thread is incomplete, follow `ShowMoreThreads`

### Recipe: search -> author -> deeper user fetch

1. call `SearchTimeline(rawQuery)`
2. extract tweet items
3. pick the relevant author from `core.user_results.result`
4. reuse that author's `rest_id` with `UserTweets` or `Followers` only if needed

## Error handling

- `400`: malformed request or missing required parameter
- `401`: missing or invalid Clawdi-managed client token
- `402`: insufficient credits
- `404`: unsupported operation
- `5xx`: upstream or proxy failure
- some upstream validation failures can return plain `Error` instead of structured JSON

For plain `Error`:

- treat it as an upstream caller-visible error
- do not pretend it is valid JSON
- adjust the request instead of trying to parse it

## Hard rules

- Read-only only. Never invent posting, liking, following, bookmarks, DMs, or moderation commands.
- Never include a `token` query parameter.
- Never invent undocumented operations outside the allowlisted set in this manual.
- Never guess a `restId`.
- Do not assume a flat top-level array response.
- Do not mutate cursors.
- Use `UserByScreenName` first when the input is only a handle and the downstream endpoint needs `restId`.
