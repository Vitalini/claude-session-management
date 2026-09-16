---
argument-hint: "[name]"
description: Save this session and exit claude — the cmux tab and its shell stay open (use /smsc to also close the tab)
allowed-tools: Bash(node:*), Bash(sqlite3:*), Bash({{CMUX_BIN}}:*)
---

Park this session and exit claude. The cmux tab stays open with its shell. Argument `$ARGUMENTS`, when given, IS the session name — use it verbatim, quotes stripped, and skip step 3. Otherwise pick a name yourself.

This ends with claude exiting after the current turn, so everything must be written before that, and the save command is the last thing you do.

Project root: `{{PROJECT_ROOT}}`

1. Finish any loose end the user already approved in this conversation (an agreed ticket worklog or comment you haven't posted yet). Don't start new work.
2. Write a short summary in {{LANG_NAME}} (2–5 sentences): what got done, key links (PR, ticket), what's left. Collect unfinished TODOs separately — both become the search index and the "what was I doing here" refresher on wake-up.
3. Name the session. If `$ARGUMENTS` is non-empty, that is the name — pass it through exactly as typed, do not improve it. Otherwise pick one yourself: 1–2 words, e.g. "Turing sample", "wallet passes"; never a session id, never a sentence. If ticket tracking is configured and this is a ticket, its key alone ({{TICKET_EXAMPLE}}) is the name. This is what the user types into `sm "<name>"` to come back.
4. Tell the user in one line what you're saving and that claude will exit (tab stays). Then run exactly once:

```bash
node {{PROJECT_ROOT}}/scripts/save-session.mjs \
  --summary "<summary>" --name "<name>" --todos "<todos or empty>" --exit
```

The script sends `/exit` into this tab; claude quits as soon as this turn ends. Relay the "Come back with: sm …" line in one line and end the turn — nothing runs after it. Do not add `--close` — closing the tab is `/smsc`.
