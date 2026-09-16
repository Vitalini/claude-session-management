---
name: sessions
description: Search, inspect, resume and hibernate the user's Claude Code sessions on their Mac (the session-management system with its SQLite index, cmux tabs and watchdog). Use whenever they ask about work sessions from Telegram or chat — "what sessions do I have on <client>", "what's running right now", "resume the billing session", "hibernate everything idle", "what crashed today", "show me sleeping sessions", "how much of the usage window is left". Trigger generously: asking from the phone is the whole point of this skill.
---

# Sessions — remote control for Claude Code sessions

The user runs many Claude Code sessions in cmux tabs on their Mac. A local system indexes them (SQLite), mirrors live cmux tabs, and watches for sessions that die on the usage limit. You are the conversational front-end to it: they ask in plain language, you query the system and answer.

Project root: `{{PROJECT_ROOT}}` (call it `$SM` below).
Dashboard API: `http://localhost:{{PORT}}` — available while the Mac is awake.

**You are read-mostly.** Searching, listing and explaining need no permission. Resuming a session costs usage quota, and hibernating closes a tab — do those only when asked for that specific action.

## Answering "what do I have on X"

```bash
node $SM/scripts/sm-resolve.mjs --list "billing"            # by text: name, title, client, folder
node $SM/scripts/sm-resolve.mjs --list "{{TICKET_EXAMPLE}}"  # by ticket key, if ticket tracking is configured
```

Output is one line per match: date, status, ticket key (empty when the session has none — ticket tracking is optional), title. Statuses mean:
- `active` — a claude is running in a cmux tab right now
- `saved` — deliberately hibernated (cold, resumable)
- `historical` — found in the transcript archive, never explicitly parked

Summarise in prose rather than dumping the raw table when there are many hits: what the sessions are about, which is freshest, whether any is live.

## Answering "what's running right now"

```bash
curl -s localhost:{{PORT}}/api/active | python3 -c "
import json,sys
tabs=json.load(sys.stdin)['tabs'] or []
live=[t for t in tabs if t['session_id']]
idle=[t for t in tabs if not t['session_id'] and t.get('db_session_id')]
print(f'live: {len(live)}, wakeable: {len(idle)}')
for t in live: print(' ·', t['workspace'], '|', t['title'])
"
```

`live` = claude actually working. `wakeable` = the tab is open but claude exited; the session is known and can be resumed in place.

## Answering "what crashed / what needs attention"

```bash
curl -s localhost:{{PORT}}/api/incidents | python3 -m json.tool
```

`pending` holds what the watchdog wants a decision on: `kind` is `limit` (hit the usage limit), `crash` (died with an error) or `warning` (the shared 5-hour window is nearly spent). Each carries an `analysis` — what that session was doing and what was left. Relay that analysis; it is the whole point of the alert.

The 5-hour window is **per account**, not per session: if it is nearly spent, every running session is at risk, and resuming several at reset would burn the fresh window immediately. Say so when it is relevant, and resume one at a time.

## Talking to a live session

You can ask a *running* session a question and relay its answer — this is how work gets checked on without opening the laptop:

```bash
node $SM/scripts/say.mjs --list                             # which sessions can be talked to
node $SM/scripts/say.mjs "{{TICKET_EXAMPLE}}" "what's the status?"    # ask, wait, print the reply
node $SM/scripts/say.mjs --wait 240 "billing" "finish the PR description"
```

The target can be a session id, a fragment of the tab title, or a ticket key when ticket tracking is configured. The message is typed into that tab and the reply comes from the session's transcript, so you get its real answer rather than a screen scrape. It waits until the reply stops growing (default ~150s); pass `--wait` for long jobs and say it's still working if it times out.

Only live sessions can be talked to. If it isn't running, offer to resume it first — don't resume silently, that costs quota.

Anything you send lands in a real working session and may change files or post to a ticket. Relay the user's intent, don't improvise instructions of your own.

## Doing things (only when asked)

Resume a session in a new cmux tab, in its own folder and workspace (a ticket URL works as well as a key):

```bash
node $SM/scripts/sm-resolve.mjs --new "{{TICKET_EXAMPLE}}"
```

If that session is already running, this switches cmux to its existing tab instead of starting a second copy, and prints `FOCUSED` — say so rather than reporting a resume. If ticket tracking is configured, a resumed ticket session is also handed a kickoff phrase asking it to check what changed on the ticket while it was parked.

Act on a watchdog incident (id from the incidents call):

```bash
curl -s -X POST localhost:{{PORT}}/api/incidents -H 'Content-Type: application/json' \
  -d '{"id": 12, "action": "resume"}'      # or "dismiss" / "snooze"
```

Hibernate a live tab — saves the session to the index and closes the tab, freeing memory:

```bash
curl -s -X POST localhost:{{PORT}}/api/hibernate -H 'Content-Type: application/json' \
  -d '{"surface": "surface:42", "workspace": "workspace:5"}'
```

Get `surface`/`workspace` from the `/api/active` call above. When asked to tidy up broadly, list what you would hibernate and let the user confirm before closing anything — a closed tab kills the claude inside it.

Refresh the index if results look stale:

```bash
curl -s -X POST localhost:{{PORT}}/api/sync
```

## When the Mac is unreachable

If `curl` to localhost:{{PORT}} fails, the dashboard service is down. Say so plainly and offer the restart command rather than guessing at data:
`launchctl kickstart -k gui/$(id -u)/com.claude-session-management.dashboard`

## Boundaries

The watchdog has its own Telegram bot for time-critical alerts with one-tap buttons. You are the conversational half: search, explain, tidy up. Don't duplicate its alerts — if asked "did anything fall over", read the incidents endpoint and report what is pending.
