# Claude Session Management

A local control room for the Claude Code sessions you run in [cmux](https://cmux.sh) tabs on macOS. It indexes every session transcript into SQLite with full-text search, so you can park a finished session (save its summary, close the tab, free the RAM) and bring it back later in the right folder and workspace with one command. A watchdog notices when a session dies on the usage limit or crashes, and pings you on Telegram with a one-tap Resume button.

<!-- screenshot: dashboard at http://localhost:3737 -->

## Requirements

- macOS
- [cmux](https://cmux.sh) — the terminal this drives (tabs, workspaces, `cmux` CLI)
- [Claude Code](https://claude.com/claude-code) (`claude` on PATH)
- Node.js 20+

## Install with Claude Code

Paste this into Claude Code:

```
Install https://github.com/Vitalini/claude-session-management — follow its INSTALL.md
```

It clones the repo, checks the prerequisites, asks three questions (language, Jira URL, run at login) and runs the installer.

## Manual install

```bash
git clone https://github.com/Vitalini/claude-session-management ~/claude-session-management
cd ~/claude-session-management
node scripts/setup.mjs
```

The installer writes `config.json`, links `sm` into `~/.local/bin`, installs the `/sm`, `/sms`, `/smsc` commands and the `session-management` skill into `~/.claude/`, registers the dashboard and watchdog as launchd services, then builds the app and indexes your existing sessions. It is idempotent — re-run it after `git pull`.

Non-interactive:

```bash
node scripts/setup.mjs --yes --lang en --jira-url https://jira.example.com
```

Flags: `--lang en|ru|uk`, `--jira-url`, `--port`, `--workspace`, `--scoping-workspace`, `--claude-flags`, `--no-launchd`, `--yes`, `--dry-run`.

## Usage

### `sm` CLI

| Command | What it does |
|---|---|
| `sm PROJ-123` | Resume that ticket's session in the current terminal; with no session yet, start claude pointed at the ticket |
| `sm "<text>"` | Same, matching titles, summaries, clients and folders |
| `sm -n <query>` | Open it in a new cmux tab, in its own folder and workspace |
| `sm -l [query]` | List/search sessions as a table |
| `sm -s` | Resync the index with reality (transcripts + live tabs) |
| `sm -d` or `sm` | Open the dashboard |
| `sm -h` | Help |

### Slash commands in Claude Code

- `/sms [name]` — save this session and exit claude; the cmux tab and its shell stay
- `/smsc [name]` — save and close the tab
- `/sm <query>` — find and restore a past session (also `/sm save`, `/sm close`, `/sm list <query>`)

The `session-management` skill does the same thing from plain language ("save session", "find the session about billing").

### Dashboard

http://localhost:3737 — live cmux tabs, saved and historical sessions, search, one-click resume and hibernate. With a Jira base URL configured it also lists your open tickets and flags sessions whose ticket is already closed.

### Watchdog and Telegram

The watchdog polls your cmux tabs. When a session hits the usage limit or crashes, it writes an incident, analyses what that session was doing, and — if Telegram is configured — sends you that briefing with Resume / Later / Skip buttons. Nothing resumes on its own: the usage window is per account, so waking a fleet at reset would burn the fresh window instantly.

To pair Telegram: create a bot with [@BotFather](https://t.me/BotFather), put its token into `.env.local` as `TELEGRAM_BOT_TOKEN`, then run

```bash
node scripts/watchdog.mjs --pair
```

and send the bot any message. Use a bot of its own — Telegram delivers updates to a single consumer, so a bot already used by another integration cannot be shared.

### Talking to a live session

```bash
node scripts/say.mjs --list                          # which sessions are live
node scripts/say.mjs "PROJ-123" "what's the status?" # ask, wait, print the reply
```

The message is typed into that session's tab; the reply is read from its transcript, not the screen.

### OpenClaw (optional)

If you run [OpenClaw](https://github.com/openclaw/openclaw), `templates/openclaw/SKILL.md` gives it a `sessions` skill so you can search, inspect and resume sessions from Telegram chat, and `templates/openclaw/group-prompt.md` is a system prompt for a dedicated group. Render `{{PROJECT_ROOT}}` and `{{PORT}}` yourself and fill in your own group and user ids. Nothing else in the tool depends on it.

## Configuration

`config.json` (created by the installer from `config.example.json`, untracked):

| Key | Meaning |
|---|---|
| `port` | Dashboard port (default 3737) |
| `language` | `en`, `ru` or `uk` — picks the kickoff phrases and the watchdog nudge |
| `jira.baseUrl` | Jira site URL; empty turns every Jira feature off and kickoff phrases use the bare ticket key |
| `jira.relevantJql` | JQL for the dashboard's ticket list |
| `jira.maxRelevant` | How many tickets that list shows |
| `phrases.scoping` | First message for a new scoping-ticket session; `{url}` is the ticket |
| `phrases.task` | First message for a new ticket session |
| `phrases.updates` | First message when an existing ticket session is resumed |
| `cmuxBin` | Path to the cmux CLI; empty means auto-detect |
| `claudeFlags` | Extra flags passed to `claude` (e.g. `--dangerously-skip-permissions` — opt-in, empty by default) |
| `defaultWorkspace` | cmux workspace for new session tabs; empty creates one named `Sessions` |
| `scopingWorkspace` | Workspace for scoping tickets; empty falls back to `defaultWorkspace` |
| `claudeProjectsDir` | Where Claude Code keeps transcripts (`~/.claude/projects`) |
| `watchdog.enabled` | Turn the watchdog off without unloading it |
| `watchdog.intervalSec` | Scan interval |
| `watchdog.warnAtPercent` | Warn when the 5-hour usage window passes this |
| `watchdog.nudge` | Message typed into a session after it is resumed |
| `watchdog.notifyKinds` | Which incidents alert you: `limit`, `crash`, `warning` |

Secrets live in `.env.local` (never committed): `JIRA_EMAIL`, `JIRA_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

## Uninstall

```bash
node scripts/uninstall.mjs
```

Removes the `sm` symlink, the slash commands, the skill and the launchd services. The repo, `config.json` and `data/` stay — delete the clone yourself if you want it gone.

## How it works

- **cmux CLI** is the hand on the terminal: it lists workspaces and tabs, opens and closes them, types into them, and reads their screens — that is how sessions get resumed, hibernated and watched.
- **Transcripts in `~/.claude/projects`** are the source of truth for what a session was: the indexer walks the `.jsonl` files for cwd, git branch, first and last prompt, ticket keys and PR links.
- **SQLite + FTS5** (`data/sessions.db`) holds the index, the saved summaries and the watchdog's incidents, which is what makes "the session about the wallet passes" findable months later.
