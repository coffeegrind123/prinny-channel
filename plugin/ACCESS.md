# Prinny — Access & Delivery

A Matrix bot is publicly addressable. Anyone who learns its MXID can invite it
to a room and start talking, and without a gate those messages would flow
straight into a session holding your filesystem and your shell. The model here
decides who gets through.

By default a message from an unknown sender triggers **pairing**: the bot
replies with a 6-character code and drops the message. You approve it with
`/prinny:access pair <code>` from your session. After that their messages pass.

All state lives in `~/.claude/channels/prinny/access.json`. The
`/prinny:access` skill edits that file; the server re-reads it on every inbound
message, so changes take effect with no restart. Set
`PRINNY_ACCESS_MODE=static` to pin config to whatever was on disk at boot —
pairing is unavailable in static mode, because it needs runtime writes.

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | Full MXID, e.g. `@bob:example.org` |
| Room key | Room ID, e.g. `!AbCdEf:example.org` — **not** a `#alias` |
| Direct message | A room with exactly two joined members |
| Config file | `~/.claude/channels/prinny/access.json` |
| Reaction emoji | Anything. Matrix has no whitelist. |

## DM policies

`dmPolicy` decides what happens to a direct message from someone not on the
allowlist.

| Policy | Behaviour |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/prinny:access pair <code>`. |
| `allowlist` | Drop silently. No reply at all — so the bot's MXID being guessed tells the guesser nothing. |
| `disabled` | Drop everything, allowlisted senders included. |

```
/prinny:access policy allowlist
```

Pairing also rate-limits itself, in ways worth knowing:

- At most **3** pending codes exist at once. Further attempts are dropped, so
  nobody can flood the pending list and lock out a real pairing.
- Each pending sender gets at most **2** replies — the code, and one reminder.
  After that the bot goes silent, so it cannot be turned into an amplifier or
  used to confirm it is listening.
- Codes expire after **1 hour**.

## Sender IDs

Matrix IDs are readable and permanent, which makes this simpler than Telegram's
numeric IDs: you can add someone without any pairing round trip.

```
/prinny:access allow @friend:example.org
/prinny:access remove @friend:example.org
```

Always the full ID, with the leading `@` and the server part. A bare localpart
matches nobody, silently.

Removing someone takes effect immediately in both directions: the outbound gate
is computed from this list, so their direct room stops being a valid reply
target the moment they leave it.

## Rooms

Shared rooms are off by default. Opt each one in.

```
/prinny:access room add !AbCdEf:example.org
/prinny:access room add !AbCdEf:example.org --no-mention
/prinny:access room add !AbCdEf:example.org --allow @bob:example.org,@alice:example.org
/prinny:access room rm !AbCdEf:example.org
```

Use the **room ID**, not the alias. An alias can be reassigned to a different
room; the ID cannot. Element shows the ID under Room Settings → Advanced.

The bot also has to actually be in the room — invite it from your client. It
accepts invites under the `pairing` policy, and declines them (by leaving)
under `allowlist` or `disabled` unless the inviter is allowlisted. Set
`autoJoinUnknown: true` to accept regardless.

With the default `requireMention: true` the bot answers only when addressed.

## Mention detection

In a room with `requireMention: true`, any of these counts:

- `m.mentions` naming the bot — the intentional-mentions field, which is what a
  modern client sends when you pick the bot from autocomplete
- A pill in `formatted_body` linking to `matrix.to/#/@bot:server`
- A reply to one of the bot's own messages
- The bot's MXID, its localpart, or its room display name as a whole word
- Any regex in `mentionPatterns`

```
/prinny:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

Whole-word matching is deliberate: "claudette" does not address `@claude`.

## Delivery

Set outbound behaviour with `/prinny:access set <key> <value>`.

**`ackReaction`** reacts to each inbound message on receipt, so the sender can
see it arrived. Any emoji; empty string disables.

```
/prinny:access set ackReaction 👀
```

**`replyToMode`** controls threading when a long reply is split. `first`
(default) puts the reply relation on the first chunk only; `all` on every
chunk; `off` never.

**`textChunkLimit`** lowers the split threshold. It is a ceiling, not a target
— Matrix's own event size limit still applies above it, and splitting happens
at boundaries the Markdown renderer chose so code blocks are closed and
reopened rather than cut in half.

**`format`** — `markdown` (default) or `text`. Markdown gets you bold, lists,
links and code blocks with no escaping, unlike Telegram's MarkdownV2.

**`notice`** sends the bot's messages as `m.notice` instead of `m.text`. That
is the Matrix convention for automated output, and it is what stops two bots in
one room from answering each other forever. Worth turning on in a shared room.

## Skill reference

| Command | Effect |
| --- | --- |
| `/prinny:access` | Print current state: policy, allowlist, pending pairings, enabled rooms. |
| `/prinny:access pair a4f91c` | Approve pairing code `a4f91c`. Adds the sender to `allowFrom` and confirms in their room. |
| `/prinny:access deny a4f91c` | Discard a pending code. The sender is not told. |
| `/prinny:access allow @bob:example.org` | Add an MXID directly. |
| `/prinny:access remove @bob:example.org` | Remove from the allowlist. |
| `/prinny:access policy allowlist` | Set `dmPolicy`: `pairing`, `allowlist`, `disabled`. |
| `/prinny:access room add !id:example.org` | Enable a room. Flags: `--no-mention`, `--allow a,b`. |
| `/prinny:access room rm !id:example.org` | Disable a room. |
| `/prinny:access set ackReaction 👀` | Set a config key: `ackReaction`, `replyToMode`, `textChunkLimit`, `format`, `notice`, `autoJoinUnknown`, `mentionPatterns`. |

## Two gates, not one

Inbound and outbound are checked separately, and both matter.

The **inbound** gate is `gate()` — policy, allowlist, room rules, mention
rules. The **outbound** gate runs on every `reply`, `react`, `edit_message`,
`download_attachment`, `fetch_messages` and `search` call: the room must be one
the inbound gate would have delivered from. Without it, a prompt injection that
reached the session could name any room on the homeserver and have the bot post
there, or read history out of a room nobody approved.

For the same reason the permission relay only ever prompts in **direct rooms**
with allowlisted senders. Everyone in `allowFrom` passed an explicit approval
step; a member of a shared room has not.

## Config file

`~/.claude/channels/prinny/access.json`. An absent file is equivalent to the
`pairing` policy with empty lists, so the first message triggers pairing.

```jsonc
{
  // Handling for direct messages from senders not in allowFrom.
  "dmPolicy": "pairing",

  // Full MXIDs allowed to message the bot directly.
  "allowFrom": ["@you:example.org"],

  // Shared rooms the bot is active in. Empty object = direct messages only.
  "rooms": {
    "!AbCdEf:example.org": {
      // true: answer only when mentioned or replied to.
      "requireMention": true,
      // Restrict triggers to these members. Empty = anyone (subject to requireMention).
      "allowFrom": []
    }
  },

  // Case-insensitive regexes that count as a mention.
  "mentionPatterns": ["^hey claude\\b"],

  // Any emoji. Empty string disables.
  "ackReaction": "👀",

  // Threading on chunked replies: first | all | off
  "replyToMode": "first",

  // Chunk ceiling. Matrix's own event limit still applies above it.
  "textChunkLimit": 3800,

  // markdown | text
  "format": "markdown",

  // Send as m.notice, the Matrix convention for automated output.
  "notice": false,

  // Accept invites from senders who are not allowlisted, even outside `pairing`.
  "autoJoinUnknown": false
}
```

`pending` is managed by the server and the skill together; leave it alone
unless you are clearing a stuck entry.
