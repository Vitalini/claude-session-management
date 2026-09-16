#!/usr/bin/env node
// Remove what setup.mjs installed outside the repo: the `sm` symlink, the
// slash commands, the skill and the launchd services. The repo, config.json
// and data/ are left alone — deleting the clone is the user's call.
//
//   node scripts/uninstall.mjs [--dry-run]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const DRY = process.argv.includes("--dry-run");
const UID = process.getuid();

const AGENTS = path.join(HOME, "Library", "LaunchAgents");
const LABELS = ["com.claude-session-management.dashboard", "com.claude-session-management.watchdog"];

// Plus any agent under an older label that still starts THIS project — matched
// by the plist pointing at this project root, never by name alone.
try {
  for (const f of fs.readdirSync(AGENTS)) {
    if (!f.endsWith(".plist")) continue;
    const label = f.replace(/\.plist$/, "");
    if (LABELS.includes(label)) continue;
    const text = fs.readFileSync(path.join(AGENTS, f), "utf8")
      .replaceAll("$HOME", HOME).replaceAll("${HOME}", HOME);
    if (text.includes(ROOT) && /npm start|watchdog\.mjs/.test(text)) LABELS.push(label);
  }
} catch {}

const say = (s) => console.log(DRY ? `would ${s}` : s);

function launchctl(args) {
  try { return execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

for (const label of LABELS) {
  if (launchctl(["print", `gui/${UID}/${label}`]) !== null) {
    say(`stop ${label}`);
    if (!DRY) launchctl(["bootout", `gui/${UID}/${label}`]);
  }
  const plist = path.join(AGENTS, `${label}.plist`);
  if (fs.existsSync(plist)) {
    say(`remove ${plist}`);
    if (!DRY) fs.rmSync(plist, { force: true });
  }
}

const smLink = path.join(HOME, ".local", "bin", "sm");
let linkTarget = null;
try { linkTarget = fs.readlinkSync(smLink); } catch {}
if (linkTarget) {
  if (linkTarget === path.join(ROOT, "scripts", "sm")) {
    say(`remove ${smLink}`);
    if (!DRY) fs.rmSync(smLink, { force: true });
  } else {
    console.log(`keep ${smLink} — it points at ${linkTarget}, not this repo`);
  }
}

for (const name of ["sm", "sms", "smsc"]) {
  const file = path.join(HOME, ".claude", "commands", `${name}.md`);
  if (fs.existsSync(file)) {
    say(`remove ${file}`);
    if (!DRY) fs.rmSync(file, { force: true });
  }
}

const skillDir = path.join(HOME, ".claude", "skills", "session-management");
if (fs.existsSync(skillDir)) {
  say(`remove ${skillDir}`);
  if (!DRY) fs.rmSync(skillDir, { recursive: true, force: true });
}

console.log(`\nDone. The repo at ${ROOT} (including config.json and data/) was left untouched.`);
console.log("An OpenClaw skill, if you installed one, lives in ~/.openclaw/ and was not removed.");
