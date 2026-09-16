#!/usr/bin/env node
// Installer for the session-management tool. Idempotent: re-running it refreshes
// config, commands, skill and services without duplicating anything.
//
//   node scripts/setup.mjs                      interactive wizard (asks everything)
//   node scripts/setup.mjs --yes                take the defaults/flags, ask nothing
//   node scripts/setup.mjs --dry-run --yes      print the plan, write nothing
//
// Flags: --lang en|ru|uk  --tickets-url <url>  --ticket-keys PROJ,OPS  --no-tickets
//        --port <n>  --workspace <name>  --scoping-workspace <name>
//        --claude-flags "<flags>"  --telegram-token <token>  --no-launchd
//        --yes  --dry-run
//
// Claude Code runs this non-interactively (its Bash tool has no TTY): it asks
// the questions itself and passes the answers as flags. See INSTALL.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { LANGS, LANG_CODES, langPreset } from "./lang.mjs";
import { detectCmuxBin } from "./cmux-detect.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const TEMPLATES = path.join(ROOT, "templates");

const LABEL_DASHBOARD = "com.claude-session-management.dashboard";
const LABEL_WATCHDOG = "com.claude-session-management.watchdog";

// ---------- args ----------

const argv = process.argv.slice(2);
// Every flag this installer understands. A value-taking flag swallows the NEXT
// argv entry verbatim unless that entry is itself a flag listed here — otherwise
// `--claude-flags "--verbose"` would silently lose its value, and flags are the
// only way Claude Code can answer the wizard.
const VALUE_FLAGS = ["lang", "tickets-url", "jira-url", "ticket-keys", "port",
  "workspace", "scoping-workspace", "claude-flags", "telegram-token"];
const BOOL_FLAGS = ["dry-run", "yes", "no-launchd", "no-tickets"];
const isKnownFlag = (s) =>
  typeof s === "string" && s.startsWith("--") &&
  [...VALUE_FLAGS, ...BOOL_FLAGS].includes(s.slice(2).split("=")[0]);

function flag(name) { return argv.includes(`--${name}`); }
function opt(name, fallback = undefined) {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next !== undefined && !isKnownFlag(next) ? next : fallback;
}
const DRY = flag("dry-run");
// --yes is the ONLY thing that silences the wizard: --dry-run still asks, so the
// answers can be reviewed against the plan before anything is written.
const YES = flag("yes");
const NO_LAUNCHD = flag("no-launchd");

// ---------- output ----------

const plan = [];
const note = (s) => { plan.push(s); console.log(s); };
const warn = (s) => { plan.push(`! ${s}`); console.log(`! ${s}`); };
const fail = (s) => { console.error(`✖ ${s}`); process.exit(1); };

function write(file, content, { mode } = {}) {
  note(`${fs.existsSync(file) ? "update" : "create"} ${file}`);
  if (DRY) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}

function run(cmd, args, { cwd = ROOT, quiet = false } = {}) {
  note(`run ${cmd} ${args.join(" ")}`);
  if (DRY) return { status: 0, stdout: "" };
  const r = spawnSync(cmd, args, { cwd, stdio: quiet ? "pipe" : "inherit", encoding: "utf8" });
  return r;
}

function launchctl(args, { check = false } = {}) {
  try {
    return execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e) {
    if (check) throw e;
    return null;
  }
}

// ---------- detection ----------

// better-sqlite3 v13 needs Node 22; Node 20 went end-of-life in April 2026.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) fail(`Node 22+ is required, this is ${process.version}.`);

function which(bin) {
  try { return execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim() || null; }
  catch { return null; }
}

const claudeBin = which("claude");
if (!claudeBin) warn("`claude` is not on PATH — install Claude Code, or the CLI and slash commands will not work.");

const cmuxBin = detectCmuxBin();
if (!cmuxBin) warn("cmux not found (/Applications/cmux.app … or on PATH) — tabs cannot be opened or closed until it is installed.");

const projectsDirDefault = "~/.claude/projects";
const projectsDir = projectsDirDefault.replace(/^~/, HOME);
if (!fs.existsSync(projectsDir)) warn(`${projectsDirDefault} does not exist yet — it appears after the first Claude Code session.`);

function cmuxWorkspaces() {
  if (!cmuxBin) return [];
  try {
    return execFileSync(cmuxBin, ["workspace", "list"], {
      encoding: "utf8", env: { ...process.env, CMUX_QUIET: "1" }, timeout: 15000,
    }).split("\n").map((l) => l.match(/workspace:\d+\s+(.+?)(?:\s+\[selected\])?\s*$/)?.[1]?.trim())
      .filter(Boolean);
  } catch { return []; }
}
const workspaces = cmuxWorkspaces();

const localBin = path.join(HOME, ".local", "bin");
const onPath = (process.env.PATH ?? "").split(":").includes(localBin);

// ---------- questions ----------

const example = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
const CONFIG_FILE = path.join(ROOT, "config.json");
const existing = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) : {};
// Older installs stored ticket settings under `jira`; carry those values into the
// tracker-agnostic `tickets` block so a re-install keeps what the user had.
const legacyTickets = existing.jira ?? {};
const existingTickets = { ...existing.tickets };
for (const k of ["baseUrl", "relevantJql", "maxRelevant"]) {
  if (!existingTickets[k] && legacyTickets[k]) existingTickets[k] = legacyTickets[k];
}

// Re-install should pre-fill what the user already uses: the project keys and the
// workspace that show up most in the index they already have.
async function fromIndex() {
  const dbFile = path.join(ROOT, "data", "sessions.db");
  if (!fs.existsSync(dbFile)) return { keys: [], workspace: "" };
  try {
    const { default: Database } = await import("better-sqlite3");
    const d = new Database(dbFile, { readonly: true, fileMustExist: true });
    const keys = d.prepare(
      `SELECT upper(substr(jira_key, 1, instr(jira_key, '-') - 1)) k, COUNT(*) n FROM sessions
       WHERE jira_key LIKE '%-%' GROUP BY k HAVING n >= 3 ORDER BY n DESC LIMIT 4`
    ).all().map((r) => r.k).filter(Boolean);
    const ws = d.prepare(
      `SELECT workspace w, COUNT(*) n FROM sessions
       WHERE workspace IS NOT NULL AND workspace != '' GROUP BY w ORDER BY n DESC LIMIT 1`
    ).get()?.w ?? "";
    d.close();
    return { keys, workspace: ws };
  } catch { return { keys: [], workspace: "" }; }
}
const seen = await fromIndex();

// Project keys as a tracker would accept them: PROJ, not "proj-123 " or "PS-".
function cleanKeys(list) {
  const out = [];
  for (const raw of list) {
    const k = String(raw ?? "").trim().toUpperCase().replace(/-\d+$/, "").replace(/-+$/, "");
    if (/^[A-Z][A-Z0-9]{0,9}$/.test(k) && !out.includes(k)) out.push(k);
  }
  return out;
}
const splitKeys = (s) => cleanKeys(String(s ?? "").split(","));

const rl = YES ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
// Answers are queued, not pulled one question at a time: piped stdin arrives in
// one chunk, and rl.question() would drop every line that had no question
// waiting for it. Stdin ending early is not a crash either — the questions left
// take their defaults.
const queued = [];   // lines read before a question asked for them
const waiting = [];  // questions waiting for a line
let stdinDone = false;
if (rl) {
  rl.on("line", (line) => (waiting.shift() ?? ((l) => queued.push(l)))(line));
  rl.once("close", () => { stdinDone = true; while (waiting.length) waiting.shift()(""); });
}

// One rule for every question: Enter keeps what is in the brackets (the value
// you have now), and a single "-" clears it. Anything else replaces it.
const CLEAR = "-";

async function ask(question, fallback = "", { secret = false } = {}) {
  if (!rl) return fallback;
  const shown = secret && fallback ? "(hidden)" : (fallback || "(blank)");
  const prompt = `${question} [${shown}]: `;
  const echo = (v) => (secret ? (String(v ?? "").trim() ? "(hidden)" : "") : v);
  let answer;
  if (queued.length) {
    answer = queued.shift();
    process.stdout.write(`${prompt}${echo(answer)}\n`);
  } else if (stdinDone) {
    process.stdout.write(`${prompt}${echo(fallback)}\n`);
    return fallback;
  } else {
    if (rl.terminal) { rl.setPrompt(prompt); rl.prompt(); } else process.stdout.write(prompt);
    answer = await new Promise((res) => waiting.push(res));
    if (!rl.terminal) process.stdout.write(`${echo(answer)}\n`); // piped stdin is not echoed
  }
  const typed = String(answer).trim();
  if (typed === CLEAR) return "";
  return typed || fallback;
}
const askYesNo = async (question, fallback) =>
  /^y/i.test(await ask(`${question} (y/n)`, fallback ? "y" : "n"));

if (rl) {
  console.log(
    "\nEnter keeps the value shown in [brackets]; type a single - to clear it.\n"
  );
}

// 1. Language
let lang = opt("lang", existing.language ?? "en");
if (!opt("lang")) lang = await ask(`Language for kickoff phrases and summaries (${LANG_CODES.join("/")})`, lang);
if (!LANGS[lang]) fail(`Unknown language "${lang}". Use one of: ${LANG_CODES.join(", ")}.`);
const preset = langPreset(lang);

// 2-4. Tickets. Optional everywhere: sessions are saved and found by name too.
const urlFlag = opt("tickets-url", opt("jira-url"));
let ticketsUrl = urlFlag ?? existingTickets.baseUrl ?? "";
let ticketKeys = splitKeys(opt("ticket-keys") ?? (existingTickets.projectKeys ?? []).join(","));
let trackTickets = !flag("no-tickets");
if (rl && !flag("no-tickets")) {
  trackTickets = await askYesNo(
    "Track tickets? (links sessions to a ticket key like PROJ-123; sessions work without it)",
    existingTickets.enabled !== false || Boolean(ticketsUrl)
  );
}
if (!trackTickets) {
  ticketsUrl = "";
  ticketKeys = [];
} else {
  if (rl && urlFlag === undefined) {
    ticketsUrl = await ask("Tracker base URL, e.g. https://acme.example.com (- turns tickets off)", ticketsUrl);
  }
  if (rl && opt("ticket-keys") === undefined) {
    const suggested = cleanKeys(ticketKeys.length ? ticketKeys : seen.keys).join(",");
    ticketKeys = splitKeys(await ask("Project keys, comma-separated, e.g. PROJ,OPS (- = any KEY-123)", suggested));
  }
}
ticketsUrl = ticketsUrl.replace(/\/+$/, "");
if (!ticketsUrl) trackTickets = false;

// 5-6. Workspaces
let workspace = opt("workspace", existing.defaultWorkspace ?? seen.workspace ?? workspaces[0] ?? "");
if (!opt("workspace")) {
  workspace = await ask(
    `Default cmux workspace for new session tabs${workspaces.length ? ` (found: ${workspaces.join(", ")})` : ""}`,
    workspace || workspaces[0] || "Sessions"
  );
}
let scopingWorkspace = opt("scoping-workspace", existing.scopingWorkspace ?? "");
if (!opt("scoping-workspace")) {
  scopingWorkspace = await ask("Workspace for scoping/research tabs (blank = same as default)", scopingWorkspace);
}

// 7. Port
let port = Number(opt("port", existing.port ?? example.port));
if (!opt("port")) port = Number(await ask("Dashboard port", String(port)));
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid port: ${port}`);

// 8. claude flags
let claudeFlags = opt("claude-flags", existing.claudeFlags ?? example.claudeFlags);
if (!opt("claude-flags")) {
  claudeFlags = await ask(
    "Extra flags for `claude` when resuming — - for none, which is the safe default;\n" +
    "  --dangerously-skip-permissions skips every permission prompt in resumed sessions\n" +
    "  flags",
    claudeFlags
  );
}

// 9. launchd
let withLaunchd = !NO_LAUNCHD;
if (!NO_LAUNCHD && rl) withLaunchd = await askYesNo("Start dashboard + watchdog at login?", true);

// 10. Telegram
let telegramToken = opt("telegram-token", "");
if (!opt("telegram-token") && rl) {
  // Never echoed: piped stdin is echoed back for the transcript, and a bot token
  // in a shared terminal log is a bot someone else owns.
  telegramToken = await ask("Telegram bot token for watchdog alerts (- to skip)", "", { secret: true });
}

if (!workspace) note('No default workspace set — new tabs will land in a workspace named "Sessions" (created on demand).');

// ---------- confirm ----------

const answers = [
  "",
  "── settings ──",
  `  language:            ${lang}`,
  `  ticket tracking:     ${trackTickets ? ticketsUrl : "off"}`,
  `  project keys:        ${trackTickets ? (ticketKeys.join(", ") || "any KEY-123") : "-"}`,
  `  default workspace:   ${workspace || "Sessions (created on demand)"}`,
  `  scoping workspace:   ${scopingWorkspace || "(same as default)"}`,
  `  dashboard port:      ${port}`,
  `  claude flags:        ${claudeFlags || "(none)"}`,
  `  start at login:      ${withLaunchd ? "yes" : "no"}`,
  `  telegram bot token:  ${telegramToken ? "set" : "not set"}`,
  "",
];
console.log(answers.join("\n"));
if (rl) {
  const ok = await askYesNo(DRY ? "Show the plan for these settings?" : "Write these settings and install?", true);
  rl.close();
  if (!ok) {
    console.log("Nothing was written. Re-run `node scripts/setup.mjs` to answer again.");
    process.exit(0);
  }
}

// ---------- config.json ----------

// Always written in the current shape — a legacy `jira` block is carried over
// into `tickets` above and then dropped.
const { jira: _legacy, tickets: _oldTickets, ...restExisting } = existing;
const config = {
  ...example,
  ...restExisting,
  port,
  language: lang,
  tickets: {
    ...example.tickets,
    ...existingTickets,
    enabled: trackTickets,
    baseUrl: ticketsUrl,
    projectKeys: ticketKeys,
  },
  phrases: { ...preset.phrases },
  // Appended to the kickoff phrase of a brand-new ticket session so it names its
  // own tab — the tab title is what search and the dashboard key off later.
  tabRule: preset.tabRule ?? "",
  cmuxBin: cmuxBin ?? "",
  claudeFlags,
  defaultWorkspace: workspace,
  scopingWorkspace,
  claudeProjectsDir: existing.claudeProjectsDir ?? example.claudeProjectsDir,
  watchdog: { ...example.watchdog, ...(existing.watchdog ?? {}), nudge: preset.nudge },
};
write(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");

// ---------- .env.local scaffold ----------

const envFile = path.join(ROOT, ".env.local");
const envScaffold = [
  "# Tracker API (optional — only needed when config.json has a tickets.baseUrl).",
  "# The dashboard's ticket lists and statuses speak the Jira Cloud REST API.",
  "#TICKET_EMAIL=you@example.com",
  "#TICKET_API_TOKEN=",
  "",
  "# Watchdog Telegram bot (optional). Create a bot with @BotFather, put the token here,",
  "# then run: node scripts/watchdog.mjs --pair",
  `${telegramToken ? "" : "#"}TELEGRAM_BOT_TOKEN=${telegramToken}`,
  "#TELEGRAM_CHAT_ID=",
  "",
].join("\n");

if (!fs.existsSync(envFile)) {
  write(envFile, envScaffold);
} else if (telegramToken) {
  // Keep every other line as it is — this file holds the user's secrets.
  const current = fs.readFileSync(envFile, "utf8");
  const line = `TELEGRAM_BOT_TOKEN=${telegramToken}`;
  const updated = /^#?\s*TELEGRAM_BOT_TOKEN=.*$/m.test(current)
    ? current.replace(/^#?\s*TELEGRAM_BOT_TOKEN=.*$/m, line)
    : `${current.replace(/\n*$/, "\n")}${line}\n`;
  write(envFile, updated);
} else {
  note(`keep ${envFile} (already present)`);
}

// ---------- templates ----------

// Example ticket key used throughout the rendered commands and skill — the
// user's own first project key when they configured one, so the docs they read
// match the keys they type.
const ticketExample = `${ticketKeys[0] ?? "PROJ"}-123`;

function render(templateRelPath) {
  const src = fs.readFileSync(path.join(TEMPLATES, templateRelPath), "utf8");
  return src
    .replaceAll("{{PROJECT_ROOT}}", ROOT)
    .replaceAll("{{CMUX_BIN}}", cmuxBin ?? "cmux")
    .replaceAll("{{PORT}}", String(port))
    .replaceAll("{{LANG_NAME}}", preset.summaryLanguage)
    .replaceAll("{{TICKET_EXAMPLE}}", ticketExample);
}

for (const name of ["sm", "sms", "smsc"]) {
  write(path.join(HOME, ".claude", "commands", `${name}.md`), render(`commands/${name}.md`));
}
write(path.join(HOME, ".claude", "skills", "session-management", "SKILL.md"), render("skill/SKILL.md"));

// ---------- sm symlink ----------

const smTarget = path.join(ROOT, "scripts", "sm");
const smLink = path.join(localBin, "sm");
if (!DRY) fs.chmodSync(smTarget, 0o755);
const currentLink = (() => { try { return fs.readlinkSync(smLink); } catch { return null; } })();
if (currentLink === smTarget) {
  note(`keep ${smLink} → ${smTarget}`);
} else {
  note(`${currentLink || fs.existsSync(smLink) ? "replace" : "create"} symlink ${smLink} → ${smTarget}`);
  if (!DRY) {
    fs.mkdirSync(localBin, { recursive: true });
    try { fs.unlinkSync(smLink); } catch {}
    fs.symlinkSync(smTarget, smLink);
  }
}
if (!onPath) warn(`${localBin} is not on your PATH. Add this line to ~/.zshrc:\n    export PATH="$HOME/.local/bin:$PATH"`);

// ---------- launchd ----------

const agents = path.join(HOME, "Library", "LaunchAgents");

const sleep = (sec) => spawnSync("/bin/sleep", [String(sec)]);
const isLoaded = (label) => launchctl(["print", `gui/${process.getuid()}/${label}`]) !== null;

// launchd tears a service down asynchronously: bootstrapping again before the
// old one is gone fails with "Input/output error", which would leave the user
// with no dashboard at all. So wait for it to disappear, and retry.
function bootout(label) {
  if (!isLoaded(label)) return false;
  note(`launchctl bootout ${label}`);
  if (DRY) return true;
  launchctl(["bootout", `gui/${process.getuid()}/${label}`]);
  for (let i = 0; i < 10 && isLoaded(label); i++) sleep(1);
  return true;
}

function bootstrap(label, file) {
  note(`launchctl bootstrap ${label}`);
  if (DRY) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, file], { encoding: "utf8" });
    if (r.status === 0 || isLoaded(label)) return;
    if (attempt === 3) {
      warn(`launchctl bootstrap ${label} failed: ${(r.stderr || r.stdout || "").trim()}`);
      return;
    }
    sleep(2);
  }
}

// Migration: earlier versions used differently-named labels. Any agent that
// starts THIS project under another label would run a second dashboard and
// watchdog, so it is stopped and its plist removed. Matching is by content —
// the plist must point at this project root — never by name alone.
function legacyLabels() {
  let files = [];
  try { files = fs.readdirSync(agents).filter((f) => f.endsWith(".plist")); } catch { return []; }
  const found = [];
  for (const f of files) {
    const label = f.replace(/\.plist$/, "");
    if (label === LABEL_DASHBOARD || label === LABEL_WATCHDOG) continue;
    let text = "";
    try { text = fs.readFileSync(path.join(agents, f), "utf8"); } catch { continue; }
    const resolved = text.replaceAll("$HOME", HOME).replaceAll("${HOME}", HOME);
    if (resolved.includes(ROOT) && /npm start|watchdog\.mjs/.test(resolved)) found.push(label);
  }
  return found;
}

for (const label of legacyLabels()) {
  const plistFile = path.join(agents, `${label}.plist`);
  bootout(label);
  note(`remove superseded plist ${plistFile}`);
  if (!DRY) fs.rmSync(plistFile, { force: true });
}

if (withLaunchd) {
  for (const [label, tpl] of [[LABEL_DASHBOARD, "launchd/dashboard.plist"], [LABEL_WATCHDOG, "launchd/watchdog.plist"]]) {
    const file = path.join(agents, `${label}.plist`);
    write(file, render(tpl));
    bootout(label);
    bootstrap(label, file);
  }
} else {
  note("skipping launchd services (--no-launchd): start them yourself with `npm start` and `node scripts/watchdog.mjs --daemon`.");
}

// ---------- build & index ----------

const npmInstall = run("npm", ["install"]);
if (npmInstall.status !== 0) fail("npm install failed.");
const build = run("npm", ["run", "build"]);
if (build.status !== 0) fail("npm run build failed.");
const index = run("node", ["scripts/index-sessions.mjs"]);
if (index.status !== 0) warn("indexing sessions failed — run `node scripts/index-sessions.mjs` again once cmux and Claude Code are set up.");

// ---------- summary ----------

const lines = [
  "",
  DRY ? "── plan only, nothing was written ──" : "── installed ──",
  `  project:     ${ROOT}`,
  `  config:      ${CONFIG_FILE} (language ${lang}${trackTickets ? `, tickets ${ticketsUrl}` : ", tickets off"})`,
  `  CLI:         ${smLink} → scripts/sm   (try: sm -h)`,
  `  commands:    ~/.claude/commands/{sm,sms,smsc}.md`,
  `  skill:       ~/.claude/skills/session-management/SKILL.md`,
  withLaunchd
    ? `  services:    ${LABEL_DASHBOARD}, ${LABEL_WATCHDOG} (launchd, start at login)`
    : "  services:    not installed (--no-launchd)",
  `  dashboard:   http://localhost:${port}`,
  "",
  "Next:",
  `  · open the dashboard: http://localhost:${port}  (or run \`sm\`)`,
  `  · save a session by name: \`/sms wallet passes\`, come back with \`sm "wallet passes"\` — no ticket needed`,
  telegramToken
    ? "  · Telegram alerts: token written to .env.local — finish pairing with `node scripts/watchdog.mjs --pair`, then send the bot any message"
    : "  · Telegram alerts when a session dies: put TELEGRAM_BOT_TOKEN in .env.local, then `node scripts/watchdog.mjs --pair`",
  trackTickets
    ? "  · Ticket lists in the dashboard: add TICKET_EMAIL and TICKET_API_TOKEN to .env.local"
    : "  · Ticket tracking is off; add a base URL to config.json → tickets to switch it on",
  "  · OpenClaw (optional): copy templates/openclaw/SKILL.md into ~/.openclaw/workspace/skills/personal/sessions/ and use templates/openclaw/group-prompt.md for the Telegram group",
];
console.log(lines.join("\n"));
