---
name: session-management
description: Save the current Claude session to cold storage and exit claude when a task is finished (the cmux tab stays open unless explicitly asked to close it), or find and restore a past session by ticket key or text. Use whenever the user says a task is done and wants to wrap up the session — "save session", "session management", "wrap up", "close the tab", "park this task", "сохрани сессию", "закрывай сессию", "заверши сессию", "збережи сесію", "закривай сесію" — or wants to find/restore an earlier session — "session management PROJ-123", "find the session", "restore the session", "where did I work on PROJ-123", "найди сессию", "восстанови сессию", "знайди сесію", "віднови сесію". Trigger generously at the end of any completed task: freeing RAM by closing tabs is the whole point, undertriggering leaves hot sessions eating memory.
---

# Session Management

Cold-store Claude sessions in SQLite so cmux tabs can be closed (freeing RAM) and reopened later with one command. Everything lives in `{{PROJECT_ROOT}}` (scripts, DB `data/sessions.db`, dashboard on http://localhost:{{PORT}}, CLI `sm`).

Two modes. Pick by intent: wrapping up the current session → **Save** (saves and exits claude; the tab stays, closing it is a separate explicit ask); looking for a past session → **Restore** (by ticket key or name, never by session id).

## Save mode — "save session"

The user finished a task (usually a ticket) and wants this session parked. Default: write the summary to the DB and EXIT claude, leaving the cmux tab with its shell open. The tab itself is closed only when the user explicitly asks for it ("close the tab", `/smsc`, `/sm close`).

1. **Wrap up loose ends first.** If the conversation has obvious unfinished business the user asked for (e.g. a ticket worklog or comment they approved but you haven't posted), do that before saving. Don't invent new work.

2. **Write a summary.** Compose 2–5 sentences in {{LANG_NAME}} covering: what was done, key decisions/links (PR, ticket), and what remains. Also collect unfinished TODOs into a short list — they'll be shown when the session is restored. Be concrete: this text is the future search index and the "what was I doing here" refresher.

3. **Pick a name.** 1–2 words, e.g. "Turing sample", "PROJ-123", "wallet passes". Never a session id, never a sentence. It is stored as the title and is what the user types into `sm "<name>"` to come back. If the work is a ticket, the key alone is the name.

4. **Save + exit** (the script identifies this cmux tab itself via `cmux identify`, extracts the session id from cmux's resume binding, stores everything, prints confirmation):

   ```bash
   node {{PROJECT_ROOT}}/scripts/save-session.mjs \
     --summary "<summary>" --name "<name>" --todos "<todos or empty>" --exit
   ```

   The script sends `/exit` into this tab, so claude quits as soon as this turn ends and the shell stays. Relay the `Come back with: sm …` hint in one line and end the turn — nothing runs after it.

5. **Save + close** — only when the user explicitly asked to close the tab. Same command with `--close` instead of `--exit`. Tell the user in one line that the tab will close, then run it exactly once. Expect the process to die mid-command — that is success, the tab closed. Do NOT run anything after it and do NOT schedule follow-ups.

   If instead it prints that the tab couldn't be identified, the session was still saved — the script refuses to close a tab it can't prove is ours (a wrong guess would kill someone else's work). Relay that and tell the user to close the tab with Cmd+W.

Before the save, tell the user in one line what you're about to save and that claude will exit — then execute. No confirmation needed: invoking this skill IS the confirmation.

Shortcuts: `/sms` = save + exit (tab stays), `/smsc` = save + close tab.

## Restore mode — "find/restore session X"

The user (often in a fresh session) wants to get back to earlier work, referenced by ticket key (PROJ-123) or free text.

1. **Search:**
   ```bash
   node {{PROJECT_ROOT}}/scripts/sm-resolve.mjs --list "<query>"
   ```
   Show the matches (status, date, title). If nothing sensible, say so and offer the dashboard (http://localhost:{{PORT}}).

2. **Open the best match in a new cmux tab** (this session cannot replace itself with another, so a new tab is the right mechanism):
   ```bash
   node {{PROJECT_ROOT}}/scripts/sm-resolve.mjs --new "<query>"
   ```
   This resumes the session in the correct folder and workspace and focuses cmux. The query can also be a full ticket URL — the key is extracted from it.

   If that session is already running, nothing is resumed: cmux switches to its existing tab and the command reports `FOCUSED`. Two claudes sharing one transcript would fight over it, so switching is the only sane answer — tell the user which tab they were taken to.

   Every path hands the session a kickoff phrase from `config.json → phrases`: a resumed ticket session is asked to check what changed on the ticket, and when no session exists yet, a fresh claude is pointed at the ticket (the scoping phrase for scoping tickets, the plain one otherwise). That's intended behavior, not a failure.

3. Mention the shell shortcut for next time: `sm PROJ-123` or `sm "<name>"` does the same from any terminal (in-place), `sm -n …` opens a new tab, `sm` alone opens the dashboard. Never suggest restoring by raw session id.

## Maintenance

- `sm -s` (or `node scripts/index-sessions.mjs`) — resync DB with reality: backfill new transcripts from `~/.claude/projects`, mark live cmux tabs active, demote closed ones to saved. Suggest it if search results look stale.
- The dashboard (http://localhost:{{PORT}}) shows live tabs, saved sessions and search over everything stored, with one-click resume. With a Jira base URL in `config.json` it also lists relevant tickets.
