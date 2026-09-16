---
argument-hint: "[name]"
description: Save this session and close its cmux tab (save + close)
allowed-tools: Bash(node:*), Bash(sqlite3:*), Bash({{CMUX_BIN}}:*)
---

Park this session and close the tab. Argument `$ARGUMENTS`, when given, IS the session name — use it verbatim, quotes stripped, and skip step 3. Otherwise pick a name yourself.

Project root: `{{PROJECT_ROOT}}`

This ends with THIS tab closing, which kills this claude process. Order matters: everything is written before the close, and the close is the last thing you do.

1. Finish any loose end the user already approved in this conversation (an agreed ticket worklog or comment you haven't posted yet). Don't start new work.
2. Write a short summary in {{LANG_NAME}} (2–5 sentences): what got done, key links (PR, ticket), what's left. Collect unfinished TODOs separately — both become the search index and the "what was I doing here" refresher on wake-up.
3. Name the session. If `$ARGUMENTS` is non-empty, that is the name — pass it through exactly as typed, do not improve it. Otherwise pick one yourself: 1–2 words, e.g. "Turing sample", "wallet passes"; never a session id, never a sentence. If ticket tracking is configured and this is a ticket, its key alone ({{TICKET_EXAMPLE}}) is the name. This is what the user types into `sm "<name>"` to come back.
4. Tell the user in one line what you're saving and that the tab will close. Then run exactly once:

```bash
node {{PROJECT_ROOT}}/scripts/save-session.mjs \
  --summary "<summary>" --name "<name>" --todos "<todos or empty>" --close
```

The command dies mid-execution — that IS success, the tab closed. Nothing runs after it.

If it instead prints that the tab couldn't be identified, the session was still saved: the script refuses to close a tab it can't prove is ours, since a wrong guess would kill someone else's work. Relay that and tell the user to close the tab with Cmd+W.
