# Naming the session tab

Do it **silently**, as your first action, before you answer. Never announce, confirm or mention the rename in your reply — the user cares about the task, not the tab.

## When

When the session starts on a ticket: the first message is a kickoff phrase ("look at the task PROJ-123", "look at the scoping …", "check what changed on …"), or the key was opened via `sm`. Not when a ticket comes up in passing during other work.

## Format

`[<TICKET-KEY>][<Client or project>] - <Short title>`

- `<Client or project>`: the short brand or project name from the ticket, not the full legal or site name.
- `<Short title>`: 2–4 words in the ticket's own vocabulary; drop the client name (already in the title), articles and filler.
- Keep the whole title under ~40 characters — tabs are narrow and clip the end. Cut words from the title, never the key.

Good: `[PROJ-123][Acme] - Auto-apply coupon`
Bad: `[PROJ-123][Acme Corporation Inc.] - Investigate why the coupon is not applied automatically`

## Command

Run this block as one unit. It renames the tab this session runs in (the caller), not whichever tab is focused:

```bash
TITLE="<title>"
CALLER_TAB=$(cmux identify 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['caller']['tab_ref'])")
[ -n "$CALLER_TAB" ] && cmux rename-tab --tab "$CALLER_TAB" "$TITLE"
```

If cmux is unavailable or the tab cannot be identified, skip it silently.
