# Mux Pairing Scope Plan

## Goal

Match vanilla OpenClaw business permissions as closely as possible while keeping mux-server as
the only chat-pairing surface.

The key UX rule is:

- users pair once in mux-server
- OpenClaw must not ask them to pair the same chat again
- sender authorization should still behave like vanilla after the chat is paired

## Desired Pairing Scope

### Telegram

- DM pairing is chat-scoped.
- If a Telegram DM uses message threads, pairing still applies to the whole DM chat.
- Group pairing is chat-scoped.
- Forum-topic pairing is also chat-scoped to the whole forum group, not the individual topic.

After pairing:

- inbound and outbound session routing can still remain topic-aware or thread-aware
- topic-level OpenClaw overrides still apply
- pairing is only the chat-level admission decision

### Discord

- DM pairing is DM-scoped.
- Guild pairing is guild-scoped.
- Pairing from a guild channel or thread should bind the whole guild, not just that one channel or
  thread.

After pairing:

- inbound and outbound session routing can still remain channel-aware or thread-aware
- pairing is only the guild-level admission decision

## Permission Model

### DM

- mux paired DM should be treated like a vanilla approved DM
- OpenClaw should not send a second native Telegram pairing reply
- sender approval may be persisted via the existing pairing allow store

### Group / Forum / Guild

- mux pairing means the chat space itself is allowed
- mux pairing does not mean every sender in that chat space is trusted
- sender authorization should still follow vanilla rules as closely as possible

For Telegram groups and forums:

- `groupPolicy`
- `groupAllowFrom`
- per-group `allowFrom`
- per-topic `allowFrom`
- `requireMention`
- `enabled`

must still apply after mux pairing.

For Discord guilds:

- guild pairing should admit the guild
- sender and command authorization should still be computed by OpenClaw, not forced trusted

## State Model

### Existing store kept for DM parity

- the existing channel/account allow-from pairing store remains correct for DM approval

### New store needed for smooth group UX

We do not want users to edit `groupAllowFrom` after mux pairing.

We also do not want to mutate:

- `channels.telegram.groups`
- `channels.telegram.groupAllowFrom`
- `channels.telegram.allowFrom`

because that would either:

- create a second source of truth
- or apply permissions too broadly

Instead, group-style sender auto-approval should use a new runtime store keyed by the broader
pairing anchor:

- Telegram chat/forum anchor: `telegram:chat:<chatId>`
- Discord guild anchor: `discord:guild:<guildId>`

That store should be used only as an additional sender-authorization source for paired group-style
routes.

## Backward Compatibility

We must keep old clients working during rollout.

### Existing mux-server bindings

Legacy bindings must continue to work:

- Telegram topic-scoped session routes under chat-scoped bindings
- Discord channel-scoped guild bindings created by older mux-server/OpenClaw versions

### Migration direction

Target end state:

- new Telegram pairings bind the chat/forum anchor
- new Discord pairings bind the guild anchor

Migration requirement:

- legacy narrower bindings remain routable until every OpenClaw instance is updated
- mux-server should accept both legacy and new binding shapes during the migration window

## Test Plan

### Existing passing coverage to preserve

- Telegram forum pairing binds one chat-scoped route while preserving topic-scoped sessions
- Telegram DM thread pairing binds one chat-scoped route while preserving thread-scoped sessions
- Discord legacy guild-thread pairing currently binds a channel-scoped route and must keep working
  during migration

### New target coverage to add first

1. Discord guild-thread pairing should bind the whole guild while preserving thread-scoped sessions.
2. Telegram mux inbound should stop forcing `CommandAuthorized=true` and instead follow the mux
   permission matrix.
3. Paired Telegram DM should not emit native pairing replies.
4. Paired Telegram group/forum should still enforce sender and mention gating.
5. Paired sender auto-approval should be scoped to the broader chat anchor:
   - Telegram whole chat/forum
   - Discord whole guild
6. Legacy narrower bindings should still route correctly during migration.

## Implementation Order

1. Write spec and target tests first.
2. Keep current legacy tests as compatibility coverage.
3. Implement mux-server pairing-anchor changes.
4. Implement OpenClaw mux permission changes.
5. Add the new paired-sender runtime store for group-style chats.
6. Remove legacy compatibility branches only after fleet migration is complete.
