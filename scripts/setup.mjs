#!/usr/bin/env node
// Installer for the session-management tool. Idempotent: re-running it refreshes
// config, commands, skill and services without duplicating anything.
//
//   node scripts/setup.mjs                      interactive (asks a few questions)
//   node scripts/setup.mjs --yes                take the defaults, ask nothing
//   node scripts/setup.mjs --dry-run --yes      print the plan, write nothing
//
// Flags: --lang en|ru|uk  --jira-url <url>  --port <n>  --workspace <name>
//        --scoping-workspace <name>  --claude-flags "<flags>"  --no-launchd
//        --yes  --dry-run

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
function flag(name) { return argv.includes(`--${name}`); }
function opt(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}
const DRY = flag("dry-run");
const YES = flag("yes") || DRY;
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

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) fail(`Node 20+ is required, this is ${process.version}.`);

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
const existing = fs.existsSync(path.join(ROOT, "config.json"))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"))
  : {};

const rl = YES ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
async function ask(question, fallback) {
  if (!rl) return fallback;
  const answer = await new Promise((res) => rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `, res));
  return answer.trim() || fallback;
}

let lang = opt("lang", existing.language ?? "en");
if (!opt("lang")) lang = await ask(`Language for kickoff phrases and summaries (${LANG_CODES.join("/")})`, lang);
if (!LANGS[lang]) fail(`Unknown language "${lang}". Use one of: ${LANG_CODES.join(", ")}.`);
const preset = langPreset(lang);

let jiraUrl = opt("jira-url", existing.jira?.baseUrl ?? "");
if (!opt("jira-url")) jiraUrl = await ask("Jira base URL (blank = Jira features off)", jiraUrl);
jiraUrl = jiraUrl.replace(/\/+$/, "");

let port = Number(opt("port", existing.port ?? example.port));
if (!opt("port")) port = Number(await ask("Dashboard port", String(port)));
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid port: ${port}`);

let workspace = opt("workspace", existing.defaultWorkspace ?? workspaces[0] ?? "");
if (!opt("workspace")) {
  workspace = await ask(
    `Default cmux workspace for new session tabs${workspaces.length ? ` (found: ${workspaces.join(", ")})` : ""}`,
    workspace
  );
}

let scopingWorkspace = opt("scoping-workspace", existing.scopingWorkspace ?? "");
if (!opt("scoping-workspace")) {
  scopingWorkspace = await ask("Workspace for scoping tickets (blank = same as default)", scopingWorkspace);
}

let claudeFlags = opt("claude-flags", existing.claudeFlags ?? example.claudeFlags);
if (!opt("claude-flags")) {
  claudeFlags = await ask('Extra flags for `claude` (e.g. --dangerously-skip-permissions; blank is safest)', claudeFlags);
}

let withLaunchd = !NO_LAUNCHD;
if (!NO_LAUNCHD && rl) {
  const a = await ask("Run the dashboard and watchdog at login? (y/n)", "y");
  withLaunchd = /^y/i.test(a);
}
rl?.close();

if (!workspace) note('No default workspace set — new tabs will land in a workspace named "Sessions" (created on demand).');

// ---------- config.json ----------

const config = {
  ...example,
  ...existing,
  port,
  language: lang,
  jira: { ...example.jira, ...(existing.jira ?? {}), baseUrl: jiraUrl },
  phrases: { ...preset.phrases },
  cmuxBin: cmuxBin ?? "",
  claudeFlags,
  defaultWorkspace: workspace,
  scopingWorkspace,
  claudeProjectsDir: existing.claudeProjectsDir ?? example.claudeProjectsDir,
  watchdog: { ...example.watchdog, ...(existing.watchdog ?? {}), nudge: preset.nudge },
};
write(path.join(ROOT, "config.json"), JSON.stringify(config, null, 2) + "\n");

// ---------- .env.local scaffold ----------

const envFile = path.join(ROOT, ".env.local");
if (!fs.existsSync(envFile)) {
  write(envFile, [
    "# Jira API (optional — only needed when config.json has a jira.baseUrl)",
    "#JIRA_EMAIL=you@example.com",
    "#JIRA_API_TOKEN=",
    "",
    "# Watchdog Telegram bot (optional). Create a bot with @BotFather, put the token here,",
    "# then run: node scripts/watchdog.mjs --pair",
    "#TELEGRAM_BOT_TOKEN=",
    "#TELEGRAM_CHAT_ID=",
    "",
  ].join("\n"));
} else {
  note(`keep ${envFile} (already present)`);
}

// ---------- templates ----------

function render(templateRelPath) {
  const src = fs.readFileSync(path.join(TEMPLATES, templateRelPath), "utf8");
  return src
    .replaceAll("{{PROJECT_ROOT}}", ROOT)
    .replaceAll("{{CMUX_BIN}}", cmuxBin ?? "cmux")
    .replaceAll("{{PORT}}", String(port))
    .replaceAll("{{LANG_NAME}}", preset.summaryLanguage);
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
  `  config:      ${path.join(ROOT, "config.json")} (language ${lang}${jiraUrl ? `, Jira ${jiraUrl}` : ", Jira off"})`,
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
  "  · Telegram alerts when a session dies: put TELEGRAM_BOT_TOKEN in .env.local, then `node scripts/watchdog.mjs --pair`",
  jiraUrl
    ? "  · Jira ticket lists: add JIRA_EMAIL and JIRA_API_TOKEN to .env.local"
    : "  · Jira features are off; add a base URL to config.json to switch them on",
  "  · OpenClaw (optional): copy templates/openclaw/SKILL.md into ~/.openclaw/workspace/skills/personal/sessions/ and use templates/openclaw/group-prompt.md for the Telegram group",
];
console.log(lines.join("\n"));
