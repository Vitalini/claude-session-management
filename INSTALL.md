# Install this tool (instructions for Claude Code)

Follow these steps in order. Stop and tell the user if a check fails.

1. **Clone.** Unless the user named another location, use `~/claude-session-management`:

   ```bash
   git clone https://github.com/Vitalini/claude-session-management ~/claude-session-management
   ```

   If the directory already exists, `cd` into it and `git pull` instead — setup is idempotent.

2. **Check the prerequisites.** All of these must pass:

   ```bash
   node -v                                                  # must be v20 or newer
   ls -d /Applications/cmux.app || which cmux               # cmux must be installed
   which claude                                             # Claude Code CLI
   ```

   If Node is older than 20: stop, tell the user to install Node 20+ (`brew install node`).
   If cmux is missing: stop, tell the user this tool drives cmux tabs and cannot work without it (https://cmux.sh).
   If `claude` is missing: stop, tell the user to install Claude Code.

3. **Ask the user exactly three questions** (and nothing else):
   - Language for kickoff phrases and session summaries: `en`, `ru` or `uk`? (default `en`)
   - Jira base URL, e.g. `https://jira.example.com`? (optional — blank turns Jira features off)
   - Run the dashboard and watchdog automatically at login? (default yes)

4. **Run the installer** with their answers:

   ```bash
   cd ~/claude-session-management
   node scripts/setup.mjs --yes --lang <en|ru|uk> [--jira-url <url>] [--no-launchd]
   ```

   Add `--no-launchd` only if they said no to step 3's third question. This installs the `sm` CLI, the `/sm`, `/sms`, `/smsc` commands, the `session-management` skill, the launchd services, then builds the app and indexes existing sessions. It takes a couple of minutes.

5. **Verify:**

   ```bash
   sm -h
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3737     # expect 200
   ```

   The dashboard may need a few seconds to come up; retry once before reporting a failure.

6. **Report to the user**, briefly:
   - Dashboard: http://localhost:3737 (or `sm` with no arguments).
   - CLI: `sm PROJ-123` resumes a ticket's session here, `sm -n …` in a new tab, `sm -l` lists, `sm -s` resyncs.
   - Slash commands: `/sms` saves this session and exits claude (the tab stays), `/smsc` also closes the tab, `/sm <query>` finds and restores a past session.
   - If `sm` is not found, `~/.local/bin` is not on PATH — add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and open a new terminal.
   - Optional extras, one line each: Telegram alerts via `node scripts/watchdog.mjs --pair` after putting a bot token into `.env.local`; Jira ticket lists need `JIRA_EMAIL` and `JIRA_API_TOKEN` in `.env.local`.
