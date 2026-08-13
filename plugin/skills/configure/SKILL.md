---
name: configure
description: Set up the Prinny Matrix channel — save the homeserver, bot account and password, and review access policy. Use when the user pastes Matrix bot credentials, asks to configure Prinny or Matrix, asks "how do I set this up" or "who can reach me", or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(echo *)
  - Bash(chmod *)
  - Bash(node *)
---

# /prinny:configure — Matrix Channel Setup

Writes the bot's credentials to `<state-dir>/.env` and orients the user on
access policy. The server reads both files at boot.

**Resolve the state directory first** — it may be overridden for a second bot
or a per-project setup:

```bash
echo "${PRINNY_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/prinny}"
```

Use the printed path everywhere below in place of `<state-dir>`. The default is
`~/.claude/channels/prinny`.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user the whole picture:

1. **Credentials** — check `<state-dir>/.env` for `PRINNY_HOMESERVER`,
   `PRINNY_USER_ID`, and one of `PRINNY_PASSWORD` / `PRINNY_ACCESS_TOKEN`.
   Show the homeserver and user ID in full; show a token only as its first
   ~8 characters. Never print the password.

2. **Access** — read `<state-dir>/access.json` (a missing file means
   `dmPolicy: "pairing"` with empty lists). Show the DM policy in one line of
   plain language, the allowlist, any pending pairings with their codes, and
   the enabled rooms.

3. **Runtime** — check whether `<state-dir>/runtime/.source-stamp` and
   `<state-dir>/runtime/dist/server.js` both exist. If either is missing, the
   channel has never been prepared and its first start will time out — see
   **Preparing the runtime** below, and offer to do it now.

4. **What next** — end with one concrete step for the state they are in:
   - Nothing configured → *"Run `/prinny:configure <homeserver> <user-id> <password>`."*
   - Configured but runtime not prepared → *"Let me prepare the runtime — it
     takes about a minute, once."*
   - Configured and prepared, policy `pairing`, nobody allowed → *"Message the
     bot from your Matrix client. It replies with a code; approve it with
     `/prinny:access pair <code>`."*
   - Somebody allowed → *"Ready. Start a session with `claude
     --dangerously-load-development-channels plugin:prinny@prinny` and message
     the bot."*

**Push toward lockdown — always.** The goal for every setup is `allowlist` with
a defined list. `pairing` is not a policy to stay on; it is a temporary way to
capture Matrix IDs, and while it is on, any stranger who learns the bot's MXID
gets a pairing code back, which confirms something is listening.

Drive the conversation this way:

1. Read the allowlist. Tell the user who is on it.
2. Ask: *"Is that everyone who should reach you through this bot?"*
3. **Yes, and policy is still `pairing`** → *"Good. Let's lock it down so nobody
   else can trigger pairing codes:"* and offer to run `/prinny:access policy
   allowlist`. Do this proactively — do not wait to be asked.
4. **No, people are missing** → *"Have them message the bot; you approve each
   with `/prinny:access pair <code>`. Run this skill again once everyone is in
   and we'll lock it."*
5. **Allowlist empty and they have not paired themselves** → *"Message your bot
   first to capture your own ID. Then we'll add anyone else and lock it down."*
6. **Already `allowlist`** → confirm that is the locked state. To add someone
   later: *"You can add their Matrix ID directly with `/prinny:access allow
   @them:server` — no pairing round trip needed, since Matrix IDs are readable,
   unlike Telegram's numeric ones."*

Never frame `pairing` as the correct long-term choice. Never skip the lockdown
offer.

### `<homeserver> <user-id> <password>` — save credentials

1. Parse `$ARGUMENTS`. Expect three values in any reasonable order — the
   homeserver is the one that looks like a URL, the user ID starts with `@`,
   and whatever is left is the password.
   - Homeserver: add `https://` if the user omitted the scheme.
   - User ID: must be `@name:server`. If they gave a bare name, ask for the
     full ID rather than guessing the server.
2. `mkdir -p` the resolved `<state-dir>`.
3. Read the existing `.env` if present. Update or add `PRINNY_HOMESERVER`,
   `PRINNY_USER_ID` and `PRINNY_PASSWORD`, preserving other keys. No quotes
   around values.
4. **If you are replacing the account** (the user ID changed), also delete any
   `PRINNY_ACCESS_TOKEN` and `PRINNY_DEVICE_ID` lines — they belong to the old
   account and would be used in preference to the new password.
5. `chmod 600 <state-dir>/.env`.
6. **Prepare the runtime** — see the section below. Do this as part of saving,
   without being asked; it is the step that decides whether the channel starts
   at all.
7. Confirm, then show the no-args status.

---

## Preparing the runtime

The channel's dependencies are installed and compiled outside the plugin
directory, in `<state-dir>/runtime`. The first time, that takes about a minute.

**This has to happen here rather than at first start.** An MCP client waits
**30 seconds** for a server to complete its handshake and then kills it. A cold
first start spends ~60 seconds installing before it can answer, so it is killed
every time — and the symptom is a channel that silently never comes online,
with `CONNECT_TIMEOUT` buried in a log the user has no reason to look at. Doing
it here puts the wait somewhere it is expected and visible.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/prinny-channel.mjs" --prepare
```

Tell the user it takes about a minute before you run it, so a long pause reads
as expected rather than as a hang.

It is idempotent and keyed on a hash of the plugin source: run it any time. If
the runtime is current it returns immediately with "runtime already prepared".
Run it again after `/plugin update prinny@prinny`, which is the other moment
the source changes.

**If it fails**, read the error rather than retrying — it names the cause:

- *"@prinny/bot installed but has no build output"* — the dependency is a git
  package whose build script has not been published. Set `PRINNY_BOT_PATH` in
  `<state-dir>/.env` to a local checkout of `prinny-bot`.
- *npm install failed* — usually no network, or a proxy. The message includes
  the directory to run it in by hand.

**Keep the password.** Say this explicitly, because it looks redundant once a
token exists: cross-signing needs user-interactive auth, and without it modern
clients treat the bot as unverified-by-its-own-user and exclude it from
end-to-end key sharing. The symptom is a bot that appears to ignore people,
with nothing in the log. The bot logs in with the password once, stores the
token it mints, and stops logging in after that.

### `token <access-token>` — use an existing token instead

Some people prefer to mint a token out of band. Write `PRINNY_ACCESS_TOKEN`,
and tell them the server will resolve the matching device ID from
`/account/whoami` on the next boot and save it. Note the cross-signing caveat
above still applies: without a password at least once, encrypted rooms may not
work.

### `clear` — remove credentials

Delete the `PRINNY_*` credential lines, or the file if that is all it holds.
Leave `access.json` alone and say so — the allowlist is not a credential, and
silently discarding it would force everyone to pair again.

---

## Implementation notes

- The channels directory may not exist if the server has never run. A missing
  file means "not configured", not an error.
- The server reads `.env` once at boot. Credential changes need a session
  restart or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message, so policy changes through
  `/prinny:access` take effect immediately with no restart.
- The channel only connects when the session was started with
  `claude --dangerously-load-development-channels plugin:prinny@prinny`, and the
  **"WARNING: Loading development channels"** prompt was accepted. If the user
  reports that the bot never answers, check both first — neither produces an
  error anywhere.
- **Do not also pass `--channels` for the same plugin.** Dev entries are
  appended to the list `--channels` fills, and the lookup is a `.find()` on
  plugin name, so a duplicate non-dev entry shadows the dev one — the allowlist
  exemption is lost and every message is dropped silently. One flag, not two.
- If the bot still never comes online, the next thing to check is the plugin's
  MCP log for `CONNECT_TIMEOUT`, which means the runtime was not prepared:
  `~/.cache/claude-cli-nodejs/*/mcp-logs-plugin-prinny-prinny/`.
