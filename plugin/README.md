# Prinny — a Matrix channel for Claude Code

Talk to your running Claude Code session from any Matrix client. Message the
bot, the message lands in your session; the assistant answers back into the
room. Permission prompts arrive as buttons you can tap from your phone — and as
a numbered list for clients that have never heard of buttons.

```sh
claude --dangerously-load-development-channels plugin:prinny@prinny
```

## What this is

A Claude Code **channel plugin**: an MCP server that bridges Matrix to the
session you are already running. It is not a bot that starts its own Claude —
your terminal session *is* the agent, and this gives it a second way in.

The design, the access model and the channel protocol are ported from
Anthropic's official [Telegram channel
plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)
(Apache-2.0). The Matrix half is built on [`@prinny/bot`](https://github.com/coffeegrind123/prinny-bot).

## What Matrix gets you that the others don't

| | Telegram | Discord | Prinny |
|---|---|---|---|
| Message history | ✗ | ✓ | ✓ `fetch_messages` |
| Search | ✗ | ✗ | ✓ `search`¹ |
| End-to-end encryption | ✗ | ✗ | ✓ |
| Reaction emoji | fixed whitelist | any | any |
| Permission prompt | buttons | buttons | buttons **and** a text fallback |
| Rich text | MarkdownV2, caller escapes | limited | Markdown, no escaping |
| Self-hosted | ✗ | ✗ | ✓ |

¹ Server-side, so it cannot see an encrypted room — the homeserver holds only
ciphertext there. The tool says exactly that rather than returning an empty
result, because "no matches" and "cannot be searched" call for different next
steps.

**The permission fallback is the part worth understanding.** When Claude Code
asks for permission, the bot sends inline buttons *and* a numbered listing in
the same message:

```
🔐 Permission requested: Bash

[1] See more
[2] Allow
[3] Deny
```

On [Prinny](https://github.com/coffeegrind123/prinny-client) you tap a button.
On Element you reply `2`. On either you can type `y abcde`. All three paths
reach the same handler, so none of them is the one that quietly rots.

## Prerequisites

- **Node 20.11+.** The server runs on Node, not Bun — `matrix-js-sdk`'s Rust
  crypto is tested there, and end-to-end encryption is not a good thing to bet
  on an untested runtime.
- **A Matrix account for the bot.** Register a second account on your
  homeserver. Do not use your own — the bot's device gets cross-signed, and you
  want to be able to revoke it separately.

## Setup

**1. Install the plugin.**

These are Claude Code commands, so start a session first.

```
/plugin marketplace add coffeegrind123/prinny-channel
/plugin install prinny@prinny
```

**2. Configure the bot account.**

```
/prinny:configure https://matrix.example.org @claude:example.org <password>
```

Writes `~/.claude/channels/prinny/.env` with mode 600, then prepares the
runtime — installing dependencies and compiling into
`~/.claude/channels/prinny/runtime`. That takes about a minute, once.

**It happens here for a reason.** An MCP client waits 30 seconds for a server
to finish its handshake, then kills it. A cold first start needs ~60 seconds to
install before it can answer, so it would be killed on every launch, and the
symptom is a channel that silently never appears. Doing it during setup puts
the wait where it is expected. To run it directly:

```sh
node "$CLAUDE_PLUGIN_ROOT/bin/prinny-channel.mjs" --prepare
```

Idempotent, and keyed on a hash of the plugin source rather than timestamps —
so copying or reinstalling the plugin does not trigger a rebuild, but a real
change does. Worth re-running after `/plugin update prinny@prinny`.

You can write the `.env` by hand instead, or export the variables in your
shell — the real environment wins over the file.

> To run several bots on one machine, point `PRINNY_STATE_DIR` at a different
> directory for each. It carries the crypto store, so two bots must never share
> one.

**Keep the password even after the first boot.** The bot logs in once, stores
the token it mints, and stops logging in — but cross-signing needs
user-interactive auth, and a bot that is not cross-signed reads as
unverified-by-its-own-user. Modern clients then exclude it from key sharing, so
it receives messages it can never decrypt. The symptom is "the bot ignores me",
with nothing in any log.

**3. Relaunch with the development-channels flag.**

```sh
claude --dangerously-load-development-channels plugin:prinny@prinny
```

**Use that flag alone — do not also pass `--channels`.** This is the single
most confusing part of installing a local channel plugin, so it is worth
stating exactly why.

Claude Code only delivers channel notifications from plugins on an approved
allowlist; Anthropic's own Discord and Telegram channels are on it, a locally
installed one is not. The development flag exempts a plugin, but only through
entries it appends to the *same* list `--channels` populates, and the lookup is
a `.find()` on plugin name:

```js
// entries = [...channelsEntries, ...devEntries]   ← dev entries appended last
entries.find(n => parts[0] === "plugin" && parts[1] === n.name)
```

Naming the plugin in **both** flags therefore creates two matching entries, and
`find` returns the first — the non-dev one. The exemption is shadowed, the
allowlist check runs, and every inbound message is dropped. Passing it only to
the development flag leaves one entry, carrying `dev: true`.

On startup you also get a confirmation titled **"WARNING: Loading development
channels"**. The dev entries are applied only if you accept it.

Without all of that the plugin still loads and the bot still logs in, so the
failure is quiet and misleading: you see a typing indicator — sent by the bot on
receipt, before the hand-off — and no reply ever arrives. The only trace:

```
Channel notifications skipped: plugin prinny@prinny is not on the
approved channels allowlist
```

Check it with:

```sh
ls -t ~/.cache/claude-cli-nodejs/*/mcp-logs-plugin-prinny-prinny/ | head -1
```

The permanent alternative, if you administer the machine, is
`allowedChannelPlugins` in `managed-settings.json`, which needs neither flag nor
dialog:

```json
{ "allowedChannelPlugins": [{ "marketplace": "prinny", "plugin": "prinny" }] }
```

Note the tradeoff the CLI documents: setting it **replaces** the default
Anthropic allowlist rather than adding to it, so list any official channels you
also use.

**4. Pair.**

From your Matrix client, start a direct chat with the bot and send anything. It
replies with a 6-character code. In your Claude Code session:

```
/prinny:access pair a4f91c
```

Your next message reaches the assistant.

**5. Lock it down.**

Pairing exists to capture Matrix IDs. Once you are in, switch policy so
strangers stop getting pairing-code replies:

```
/prinny:access policy allowlist
```

Unlike Telegram, you never need the pairing round trip to add someone — Matrix
IDs are readable, so `/prinny:access allow @friend:example.org` is enough.

## Access control

See **[ACCESS.md](./ACCESS.md)** for policies, rooms, mention detection,
delivery configuration and the `access.json` schema.

Quick reference: IDs are full MXIDs (`@name:server`), rooms are room IDs
(`!opaque:server`, not `#alias`). The default policy is `pairing`. Every
setting is re-read on each inbound message, so nothing needs a restart except
credentials.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a room. Takes `room_id` + `text`, optionally `reply_to` (an event ID) and `files` (absolute paths). Markdown by default. Images, video and audio go with the matching msgtype so clients render them inline; anything else goes as a document. Encrypted automatically in an encrypted room. Long text is split at boundaries the Markdown renderer chose, so code blocks survive the split. |
| `react` | Add an emoji reaction to an event. Any emoji. |
| `edit_message` | Edit a message the bot sent, as a real Matrix `m.replace`. For "working…" → result updates. |
| `download_attachment` | Fetch and decrypt the attachment on any event, by room and event ID. Returns a local path. |
| `fetch_messages` | Room history, oldest first, with event IDs. Backfills from the server when the synced timeline is short. |
| `search` | Server-side full-text search in one room. Reports plainly when the room is encrypted and therefore unsearchable. |

Inbound messages trigger a typing indicator automatically, so the room shows
the bot is working before the reply lands.

## Messages sent while you were away

The channel only exists while a Claude Code session does. Close the session and
the bot is not idle — it is gone. Anything sent meanwhile is held by your
homeserver, and picked up on the next start:

```
prinny channel: 3 message(s) queued while away — delivering
prinny channel: delivered 3 queued message(s), 0 left
```

Backlog items arrive with `delayed="true"`, `queued_for="8521s"` and
`backlog_position="2/3"` in their `<channel>` meta, so the assistant answers in
the right tense instead of treating an hours-old message as something just
said.

**Every inbound message is written to `<state-dir>/queue.json` before it is
handed to the session, and removed only once it has been.** That ordering is
the whole design: a crash between receiving and delivering leaves the message
queued rather than lost. A delivery watermark in `<state-dir>/watermark.json`
records the newest message a session has actually seen, so a restart picks up
from there instead of either replaying old conversations or skipping the gap.

Bounds, and what happens at each:

| | |
| --- | --- |
| Queue length | 50 messages. Over that the **oldest** are dropped — on return you want the end of a conversation, not its start. |
| Age | 7 days. Older entries are discarded on the next write. |
| Outage length | The catch-up sees only what the initial sync returns (50 events per room), so a long enough outage still loses the oldest of it. |
| First run | No watermark means no notion of "while away", so the bot starts from now rather than replaying room history. |

Anything dropped is logged rather than silently truncated. A failed delivery
stops the drain: the rest stays queued and in order, because delivering out of
order would reorder someone's conversation.

## Attachments

Images are downloaded eagerly on arrival — decrypted, written to
`~/.claude/channels/prinny/inbox/`, and the path handed over in the `<channel>`
tag so the assistant can `Read` it without a round trip. Everything else is
announced in the tag and fetched on demand with `download_attachment`.

Outbound paths are checked before sending: the channel refuses to send its own
state directory. Its credentials, crypto store and allowlist are the one thing
it has no reason to ever hand out, and "send me your .env" is exactly the shape
a prompt injection takes.

## Encryption

The bot runs E2EE by default and **refuses to start if crypto fails to
initialise**. Pass `PRINNY_ALLOW_UNENCRYPTED=1` to override, and think about it
first: a crypto failure that silently downgraded the bot to plaintext, in rooms
everyone believed were encrypted, is worse than a bot that does not start.

The crypto store lives under the state directory and must survive restarts.
Losing it makes the bot mint a new Olm identity on every boot, and peers stop
sharing room keys with a device whose keys keep changing.

## Troubleshooting

**The bot comes online and shows a typing indicator, but nothing ever arrives.**
The channel is connected but its notifications are being discarded — the
plugin is not on the approved channels allowlist. Relaunch with
`--dangerously-load-development-channels plugin:prinny@prinny`, or add it to
`allowedChannelPlugins` (see step 3). The typing indicator is misleading here:
it is sent by the bot on receipt, before the message is handed to the session,
so it proves only that the *inbound* half works.

**The bot never answers at all.** Check the session was started with
`--channels`. This is the single most common cause and it produces no error
anywhere.

**The channel never comes online.** Check the plugin's MCP log for
`CONNECT_TIMEOUT`:

```sh
cat ~/.cache/claude-cli-nodejs/*/mcp-logs-plugin-prinny-prinny/*.jsonl
```

That means the server was killed before it finished its handshake — almost
always an unprepared runtime. Run `/prinny:configure`, or the `--prepare`
command above, and start again. As a last resort `MCP_TIMEOUT=120000 claude …`
widens the budget.

**First reply after a restart is slow.** Loading `matrix-js-sdk` and its Rust
crypto module takes ~15 seconds. That happens *after* the MCP handshake
completes — deliberately, because loading a module that size blocks the event
loop, and doing it earlier stalls the handshake past the 30-second limit. The
session is usable throughout; the bot connects a moment later.

**"Multiple matrix-js-sdk entrypoints detected!"** Something installed a second
copy of the SDK alongside `@prinny/bot`'s. This plugin deliberately does not
depend on `matrix-js-sdk` directly and imports the SDK symbols it needs from
`@prinny/bot`; keep it that way.

**The bot receives messages it cannot decrypt.** Its device is not
cross-signed. Configure the password and restart it once.

**A JSON parse error from the MCP client.** Something wrote to stdout, which is
the JSON-RPC stream. `src/stdout-guard.ts` takes fd 1 for the transport and
points every other writer at stderr, so this should not happen — but if you add
an import above it, it will. matrix-js-sdk logs "Downloading Rust crypto
library" to stdout on the way up, and that one line is enough to kill the
channel. The guard must stay the first import in `server.ts`.

## Layout, and why dependencies live elsewhere

```
prinny-channel/          repo root — dev harness, never needed at runtime
├── .claude-plugin/      marketplace manifest, source: ./plugin
├── package.json         lint / typecheck / test
├── test/
└── plugin/              ← the payload. 19 files, 144KB.
    ├── .claude-plugin/  plugin manifest
    ├── .mcp.json
    ├── bin/             bootstrap
    ├── src/
    └── skills/
```

A plugin is delivered as a **copy of its directory**, so anything sitting in it
is copied on every install. `node_modules` for matrix-js-sdk is ~105MB across
~7,500 files; on a network or 9p-backed home directory that copy takes minutes,
and it happens twice. A `file:` dependency symlink does not survive the move
either — it is relative, so the installed copy points at nothing.

So the payload ships **source only**, and `bin/prinny-channel.mjs` stages a
runtime directory beside the channel's state on first run:

```
~/.claude/channels/prinny/runtime/{package.json,src,node_modules,dist}
```

One machine, one dependency tree, however many times the plugin is copied or
upgraded. Staging is keyed on a fingerprint of the source, so an upgrade
recompiles and an unchanged plugin starts straight away. Override the location
with `PRINNY_RUNTIME_DIR`.

## Development

```sh
npm install
npm run dev:link     # use the sibling ../prinny-bot checkout instead of the git dep
npm run check        # lint, typecheck, test
```

`npm run dev:link` is needed because a plain `npm install` fetches `@prinny/bot`
from GitHub, which hides local changes to it. The bootstrap does the equivalent
automatically: if a sibling `prinny-bot` checkout exists, the runtime dir uses
it. Point `PRINNY_BOT_PATH` at one explicitly to override.

To exercise the real install path, copy `plugin/` somewhere clean and run
`plugin/bin/prinny-channel.mjs` with `PRINNY_STATE_DIR` set to a scratch
directory — that is the only way to catch a dependency the payload cannot
reach.

## Licence

MIT. See [LICENSE](./LICENSE).

Ported from the Telegram channel plugin in
[anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official),
Apache-2.0.
