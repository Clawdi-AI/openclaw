---
name: x-api-readonly
description: Read-only skill for Clawdi's X/Twitter data proxy. Use it to look up users, fetch tweets, replies, followers, following, user media, tweet threads, list timelines, community timelines, and search results from fixed gateway endpoints.
metadata:
  emoji: bird
  requires:
    bins: ["curl"]
    env: ["COMPOSIO_MCP_TOKEN"]
---

# X API Readonly

Use Clawdi's fixed X/Twitter proxy at `https://api.clawdi.com/proxy/twitter`.

Request form:

```bash
curl --silent --show-error --get \
  -H "Authorization: Bearer $COMPOSIO_MCP_TOKEN" \
  --data-urlencode "<param>=<value>" \
  "https://api.clawdi.com/proxy/twitter/<Operation>"
```

Read-only scope:
- Supported: user lookup, user timelines, replies, media, followers, following, tweet detail, search, list timelines, community timelines.
- Not supported: posting, likes, bookmarks, follows, DMs, deletes, account settings, or any operation outside the documented gateway allowlist.

## Operations

| Operation | Required query param | Response root | Main payload | Use |
| --- | --- | --- | --- | --- |
| `UserByScreenName` | `screenName` | `data.user.result` | one user object | resolve `@handle` to user identity and `rest_id` |
| `UserTweets` | `restId` | `data.user.result.timeline.timeline.instructions` | tweet timeline instructions | latest tweets from a user |
| `UserTweetsAndReplies` | `restId` | `data.user.result.timeline.timeline.instructions` | tweet timeline instructions | latest tweets plus replies from a user |
| `UserMedia` | `restId` | `data.user.result.timeline.timeline.instructions` | tweet timeline instructions | tweets from a user that include media |
| `Followers` | `restId` | `data.user.result.timeline.timeline.instructions` | user timeline instructions | accounts following the user |
| `Following` | `restId` | `data.user.result.timeline.timeline.instructions` | user timeline instructions | accounts the user follows |
| `SearchTimeline` | `rawQuery` | `data.search_by_raw_query.search_timeline.timeline.instructions` | tweet timeline instructions | keyword, phrase, cashtag, hashtag, or boolean-like X search |
| `TweetDetail` | `restId` | `data.threaded_conversation_with_injections_v2.instructions` | thread instructions | tweet detail, replies, and thread context |
| `ListLatestTweetsTimeline` | `listId` | `data.list.tweets_timeline.timeline.instructions` | tweet timeline instructions | latest tweets from an X list |
| `CommunityTweetsTimeline` | `communityId` | `data.communityResults.result.ranked_community_timeline.timeline.instructions` | tweet timeline instructions | recent community timeline content |

Known optional parameter:
- `CommunityTweetsTimeline` may accept `rankingMode=Recency`. This value was observed working and yields recent-first community results.

## Return Value Types

The API returns four structural families. Treat them like these schema definitions:

```ts
type UserResultResponse = {
  data: {
    user: {
      result: User
    }
  }
}

type TweetTimelineResponse = {
  data: {
    user?: {
      result: {
        timeline: {
          timeline: {
            instructions: Instruction[]
          }
        }
      }
    }
    search_by_raw_query?: {
      search_timeline: {
        timeline: {
          instructions: Instruction[]
        }
      }
    }
    list?: {
      tweets_timeline: {
        timeline: {
          instructions: Instruction[]
        }
      }
    }
    communityResults?: {
      result: {
        ranked_community_timeline: {
          timeline: {
            instructions: Instruction[]
          }
        }
      }
    }
  }
}

type UserTimelineResponse = {
  data: {
    user: {
      result: {
        timeline: {
          timeline: {
            instructions: Instruction[]
          }
        }
      }
    }
  }
}

type ThreadResponse = {
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: Instruction[]
    }
  }
}
```

Operation to response family:

```ts
type OperationResponseMap = {
  UserByScreenName: UserResultResponse
  UserTweets: TweetTimelineResponse
  UserTweetsAndReplies: TweetTimelineResponse
  UserMedia: TweetTimelineResponse
  SearchTimeline: TweetTimelineResponse
  ListLatestTweetsTimeline: TweetTimelineResponse
  CommunityTweetsTimeline: TweetTimelineResponse
  Followers: UserTimelineResponse
  Following: UserTimelineResponse
  TweetDetail: ThreadResponse
}
```

Useful normalized extraction targets:

```ts
type ResolvedUser = User
type TweetItem = Tweet
type UserItem = User
type MediaItem = Media
type CursorItem = Cursor
```

## Input Rules

- `screenName`: X handle without `@`.
- `restId`: numeric X entity id as a string. Used for users and tweets.
- `rawQuery`: literal X search query string. Pass the exact query you want X search to interpret.
- `listId`: numeric list id as a string.
- `communityId`: numeric community id as a string.
- Always use `curl --get --data-urlencode`.
- Handle -> `UserByScreenName` first.
- Tweet URL -> extract numeric tweet id -> `TweetDetail`.

## Traversal Model

Most endpoints return an instruction tree, not a flat array:

1. Start at the endpoint's documented response root.
2. Find `TimelineAddEntries`.
3. Read `entries[]`.
4. Inspect `entry.content`.
5. Handle `itemContent`, `items`, or `cursorType`.
6. Descend through wrappers until you reach the entity payload.

Common wrappers you may see:
- Tweet timeline item: `entry.content.itemContent.tweet_results.result`
- User timeline item: `entry.content.itemContent.user_results.result`
- Module item tweet: `entry.content.items[n].item.itemContent.tweet_results.result`
- Module item user: `entry.content.items[n].item.itemContent.user_results.result`
- Cursor: `entry.content.value` with `entry.content.cursorType`

Practical extraction rule:
- Ignore entries that are only cursors, ads, prompts, or non-entity modules unless your task explicitly needs pagination.
- Return tweets from `tweet_results.result`.
- Return users from `user_results.result`.
- Preserve cursor values when another page may be needed.

## Object Map

```ts
type User = {
  rest_id: string
  core?: {
    name?: string
    screen_name?: string
  }
  legacy?: {
    description?: string
    created_at?: string
    followers_count?: number
    friends_count?: number
    statuses_count?: number
    media_count?: number
    profile_image_url_https?: string
    profile_banner_url?: string
    verified?: boolean
  }
  is_blue_verified?: boolean
  privacy?: {
    protected?: boolean
  }
  dm_permissions?: unknown
  relationship_perspectives?: unknown
}

type Tweet = {
  rest_id: string
  core?: {
    user_results?: {
      result?: User
    }
  }
  legacy?: {
    full_text?: string
    created_at?: string
    favorite_count?: number
    retweet_count?: number
    reply_count?: number
    quote_count?: number
    bookmark_count?: number
    conversation_id_str?: string
    in_reply_to_status_id_str?: string
    in_reply_to_user_id_str?: string
    in_reply_to_screen_name?: string
    entities?: {
      urls?: unknown[]
      user_mentions?: unknown[]
      hashtags?: unknown[]
      media?: Media[]
    }
  }
  views?: {
    count?: string
  }
  quoted_status_result?: {
    result?: Tweet
  }
  note_tweet?: {
    note_tweet_results?: {
      result?: {
        text?: string
      }
    }
  }
  card?: unknown
  edit_control?: unknown
}

type Media = {
  type?: "photo" | "video" | "animated_gif"
  media_url_https?: string
  ext_media_availability?: {
    status?: string
  }
  video_info?: {
    variants?: unknown[]
  }
  sizes?: unknown
}

type Cursor = {
  entryId?: string
  cursorType?: "Top" | "Bottom" | "ShowMore" | "ShowMoreThreads"
  value?: string
}

type TimelineItemContent =
  | {
      itemType?: "TimelineTweet"
      tweet_results?: { result?: Tweet }
    }
  | {
      itemType?: "TimelineUser"
      user_results?: { result?: User }
    }

type TimelineEntry = {
  entryId?: string
  content?: {
    itemContent?: TimelineItemContent
    items?: Array<{
      item?: {
        itemContent?: TimelineItemContent
      }
    }>
    cursorType?: Cursor["cursorType"]
    value?: string
  }
}

type Instruction = {
  type?: string
  entries?: TimelineEntry[]
}
```

## Canonical Examples

```bash
curl --silent --show-error --get \
  -H "Authorization: Bearer $COMPOSIO_MCP_TOKEN" \
  --data-urlencode "screenName=limichange2" \
  "https://api.clawdi.com/proxy/twitter/UserByScreenName"
```

Handle lookup result:

```json
{"data":{"user":{"result":{"rest_id":"1212607092600606722","core":{"name":"Example User","screen_name":"limichange2"},"legacy":{"description":"Bio","followers_count":123,"friends_count":45,"statuses_count":678,"media_count":9,"profile_image_url_https":"https://..."},"is_blue_verified":false}}}}
```

Tweet timeline entry:

```json
{"entryId":"tweet-1897289524193214579","content":{"itemContent":{"itemType":"TimelineTweet","tweet_results":{"result":{"rest_id":"1897289524193214579","core":{"user_results":{"result":{"rest_id":"1212607092600606722","core":{"name":"Example User","screen_name":"limichange2"}}}},"legacy":{"full_text":"tweet text","created_at":"Fri Mar 07 10:00:00 +0000 2025","favorite_count":12,"retweet_count":3,"reply_count":1,"quote_count":0,"conversation_id_str":"1897289524193214579","entities":{"hashtags":[],"user_mentions":[],"urls":[]}},"views":{"count":"400"}}}}}}
```

Follower/following entry:

```json
{"entryId":"user-123","content":{"itemContent":{"itemType":"TimelineUser","user_results":{"result":{"rest_id":"987654321","core":{"name":"Follower Name","screen_name":"follower_handle"},"legacy":{"description":"Profile text","followers_count":500,"friends_count":120,"statuses_count":2100,"profile_image_url_https":"https://..."},"is_blue_verified":true}}}}}
```

Tweet detail thread item plus cursor:

```json
{"instructions":[{"type":"TimelineAddEntries","entries":[{"entryId":"conversationthread-1","content":{"items":[{"item":{"itemContent":{"itemType":"TimelineTweet","tweet_results":{"result":{"rest_id":"1897289524193214579","legacy":{"full_text":"root or reply tweet"}}}}}}]}},{"entryId":"cursor-showmorethreads-1","content":{"cursorType":"ShowMoreThreads","value":"cursor-token"}}]}]}
```

## Quick Recipes

| Goal | Steps |
| --- | --- |
| Handle to tweets | `UserByScreenName` -> read `data.user.result.rest_id` -> call `UserTweets`, `UserTweetsAndReplies`, or `UserMedia` |
| Handle to followers/following | `UserByScreenName` -> read `rest_id` -> call `Followers` or `Following` |
| Tweet URL to conversation | extract numeric tweet id -> call `TweetDetail` |
| Topic to recent tweets | call `SearchTimeline(rawQuery)` and traverse tweet entries |
| List monitoring | call `ListLatestTweetsTimeline(listId)` |
| Community monitoring | call `CommunityTweetsTimeline(communityId)` and optionally `rankingMode=Recency` |

## Pagination

- Timeline endpoints commonly include `Top` and `Bottom` cursors.
- `TweetDetail` commonly includes `ShowMore` and `ShowMoreThreads`.
- Cursor presence means more data may exist beyond the current page.
- Preserve cursor tokens in your own structured output when pagination matters.

## Error Handling

- Treat non-2xx HTTP responses as request failures.
- Treat a plain string response such as `Error` as an upstream failure or invalid parameter combination.
- If an expected response root is absent, inspect whether the response is an error payload before assuming the schema changed.
- Do not invent missing fields. Only report fields present in the payload you received.

## Hard Rules

- Stay inside the documented operations only.
- Treat the API as read-only.
- Use the fixed gateway base URL exactly as written.
- Use the documented response roots; do not guess alternate roots.
- Use `UserByScreenName` before id-based user endpoints when starting from a handle.
- Use encoded query parameters rather than raw string concatenation.
- Prefer normalized output that preserves ids, handles, timestamps, counts, media URLs, and cursor values.
