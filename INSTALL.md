# Install this tool (instructions for Claude Code)

Your Bash tool has no interactive TTY, so **you ask the wizard's questions yourself** — in your own question UI, or plain chat — and then run the installer non-interactively with the answers as flags. Never run `node scripts/setup.mjs` without `--yes`: it would wait for input you cannot give.

*(A human installing by hand just runs `node scripts/setup.mjs` and gets the same wizard in the terminal.)*

1. **Clone.** Unless the user named another location, use `~/claude-session-management`:

   ```bash
   git clone https://github.com/Vitalini/claude-session-management ~/claude-session-management
   ```

   If the directory exists, `cd` into it and `git pull` instead — setup is idempotent.

2. **Check the prerequisites.** All must pass:

   ```bash
   node -v                                        # v22 or newer
   ls -d /Applications/cmux.app || which cmux     # cmux must be installed
   which claude                                   # Claude Code CLI
   ```

   Node older than 22 → stop, tell the user to `brew install node`. No cmux → stop, this tool drives cmux tabs and cannot work without it (https://cmux.sh). No `claude` → stop, tell them to install Claude Code.

3. **Ask the user.** Questions 1–4, 9 and 10 always; take the defaults for 5–8 unless the user wants to set them.

   | # | Question | Default |
   |---|---|---|
   | 1 | Language for kickoff phrases and summaries: `en` / `ru` / `uk` | `en` |
   | 2 | Track tickets? Sessions can be saved and found by name alone. | yes |
   | 3 | Tracker base URL, e.g. `https://acme.example.com` — `-` turns tickets off | blank |
   | 4 | Project keys, comma-separated, e.g. `PROJ,OPS` — `-` matches any `KEY-123` | blank |
   | 5 | Default cmux workspace for new session tabs | first detected, else `Sessions` |
   | 6 | Workspace for scoping/research tabs | same as 5 |
   | 7 | Dashboard port | `3737` |
   | 8 | Extra flags for `claude` when resuming — `-` for none, which is safe; `--dangerously-skip-permissions` skips every permission prompt | blank |
   | 9 | Start dashboard + watchdog at login? | yes |
   | 10 | Telegram bot token for watchdog alerts — `-` to skip | blank |

   Skip 3 and 4 if they answered no to 2. In the terminal wizard, Enter keeps the value shown in brackets and a single `-` clears it — so a re-install never silently keeps a setting the user meant to drop.

4. **Run the installer** with their answers:

   ```bash
   cd ~/claude-session-management
   node scripts/setup.mjs --yes --lang <en|ru|uk> \
     [--tickets-url <url>] [--ticket-keys PROJ,OPS] [--no-tickets] \
     [--workspace <name>] [--scoping-workspace <name>] [--port <n>] \
     [--claude-flags "<flags>"] [--telegram-token <token>] [--no-launchd]
   ```

   Pass `--no-tickets` when they said no to question 2, `--no-launchd` when they said no to question 9. This installs the `sm` CLI, the `/sm`, `/sms`, `/smsc` commands, the `session-management` skill and the launchd services, then builds the app and indexes existing sessions. It takes a couple of minutes.

5. **Verify:**

   ```bash
   sm -h
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3737     # expect 200
   ```

   The dashboard may need a few seconds; retry once before reporting a failure.

6. **Report to the user**, briefly:
   - Dashboard: http://localhost:3737 (or `sm` with no arguments).
   - CLI: `sm "wallet passes"` resumes a saved session here, `sm PROJ-123` does it by ticket key, `sm -n …` opens a new tab, `sm -l` lists, `sm -s` resyncs.
   - Slash commands: `/sms` saves this session and exits claude (the tab stays), `/smsc` also closes the tab, `/sm <query>` finds and restores a past session.
   - If `sm` is not found, `~/.local/bin` is not on PATH — add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and open a new terminal.
   - Optional, one line each: Telegram alerts need `node scripts/watchdog.mjs --pair` after a bot token is in `.env.local`; ticket lists in the dashboard need `TICKET_EMAIL` and `TICKET_API_TOKEN` there too.
