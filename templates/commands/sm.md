---
description: Session Management — save+exit this session (tab stays), save+close its tab, or find/restore a past one
argument-hint: "save [name] | close [name] | <name or {{TICKET_EXAMPLE}} to find> | list <query>"
allowed-tools: Bash(node:*), Bash(sqlite3:*), Bash({{CMUX_BIN}}:*)
---

Session Management. Argument: `$ARGUMENTS` (empty means `save`).

Project root: `{{PROJECT_ROOT}}`

## `save [name]` (or no argument) — park this session and exit claude, keep the tab

Anything after `save` is the session name — use it verbatim instead of inventing one.

1. Finish any loose end the user already approved in this conversation (an agreed ticket worklog or comment you haven't posted yet). Don't start new work.
2. Write a short summary in {{LANG_NAME}} (2–5 sentences): what got done, key links (PR, ticket), what's left. Collect unfinished TODOs separately — both become the search index and the "what was I doing here" refresher on wake-up.
3. Name the session: the words the user passed after `save`/`close`, verbatim. If they passed none, pick one yourself — 1–2 words, e.g. "Turing sample", "wallet passes"; never a session id, never a sentence. If ticket tracking is configured and this is a ticket, its key alone ({{TICKET_EXAMPLE}}) is the name. This is what the user types into `sm "<name>"` to come back.
4. Tell the user in one line what you're saving and that claude will exit (tab stays). Then run exactly once:

```bash
node {{PROJECT_ROOT}}/scripts/save-session.mjs \
  --summary "<summary>" --name "<name>" --todos "<todos or empty>" --exit
```

The script sends `/exit` into this tab; claude quits as soon as this turn ends and the shell stays. Relay the "Come back with: sm …" line and end the turn. Shortcut: `/sms`.

## `close [name]` — park this session AND close the tab

Anything after `close` is the session name — use it verbatim.

Same as `save`, but with `--close` instead of `--exit`, and this ends with THIS tab closing, which kills this claude process. Everything is written before the close, and the close is the last thing you do. Tell the user in one line that the tab will close, then run exactly once:

```bash
node {{PROJECT_ROOT}}/scripts/save-session.mjs \
  --summary "<summary>" --name "<name>" --todos "<todos or empty>" --close
```

The command dies mid-execution — that IS success, the tab closed. Nothing runs after it.

If it instead prints that the tab couldn't be identified, the session was still saved: the script refuses to close a tab it can't prove is ours, since a wrong guess would kill someone else's work. Relay that and tell the user to close the tab with Cmd+W. Shortcut: `/smsc`.

## Anything else — find and restore

`$ARGUMENTS` is free text — the name the session was saved under — or, if ticket tracking is configured, a ticket key or full ticket URL (`list <query>` means: only show matches, don't open anything).

```bash
node {{PROJECT_ROOT}}/scripts/sm-resolve.mjs --list "<query>"
```

Show the matches (status, date, title). Then, unless the user asked only to list, open the best one in a new cmux tab — this session can't replace itself, so a new tab is the right move:

```bash
node {{PROJECT_ROOT}}/scripts/sm-resolve.mjs --new "<query>"
```

If ticket tracking is configured, the new session starts with a kickoff phrase from `config.json → phrases`: a resumed one is asked to check what changed on its ticket, a brand-new one is pointed at the ticket (scoping or regular). That's intended, not a failure. Without a ticket the session just resumes.

Mention once that `sm "<name>"` (or `sm {{TICKET_EXAMPLE}}`) in any terminal does the same thing in place, and `sm` alone opens the dashboard at http://localhost:{{PORT}}.
