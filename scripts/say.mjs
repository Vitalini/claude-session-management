#!/usr/bin/env node
// Talk to a running Claude session from outside it: type a message into its
// cmux tab and wait for the reply. The reply is read from the session's
// transcript, not the screen — screens wrap, truncate and repaint.
//
//   node say.mjs "wallet passes" "what's the status?"
//   node say.mjs --wait 180 <session-id|query> "message"
//   node say.mjs --list                 # which sessions are live right now

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CONFIG, searchSessions, getSession } from "./db.mjs";
import { cmux } from "./cmux-lib.mjs";
import { liveScan } from "./index-sessions.mjs";

const PROJECTS_DIR = CONFIG.claudeProjectsDir.replace(/^~/, os.homedir());
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const waitSec = Number(flag("wait", "150"));
const listOnly = args.includes("--list");

function liveTabs() {
  return (liveScan()?.tabs ?? []).filter((t) => t.session_id);
}

if (listOnly) {
  for (const t of liveTabs()) console.log(`${t.session_id}\t${t.workspace}\t${t.title}`);
  process.exit(0);
}

const [query, ...rest] = args;
const message = rest.join(" ").trim();
if (!query || !message) {
  console.error('usage: node say.mjs "<session id | PS-key | text>" "<message>"');
  process.exit(2);
}

// Which session did he mean, and is it actually running?
const tabs = liveTabs();
const isUuid = /^[0-9a-f-]{36}$/i.test(query);
let target = tabs.find((t) => t.session_id === query.toLowerCase());
if (!target && !isUuid) {
  const needle = query.toLowerCase();
  target = tabs.find((t) => (t.title ?? "").toLowerCase().includes(needle));
  if (!target) {
    const hit = searchSessions(query, { limit: 1 })[0];
    if (hit) target = tabs.find((t) => t.session_id === hit.session_id);
  }
}
if (!target) {
  const row = isUuid ? getSession(query) : searchSessions(query, { limit: 1 })[0];
  console.error(row
    ? `Session "${row.title ?? row.session_id}" is not running right now — resume it first (sm -n ${row.jira_key ?? row.session_id}).`
    : `No live session matches "${query}". Live now:\n` + tabs.map((t) => ` · ${t.title} (${t.workspace})`).join("\n"));
  process.exit(1);
}

// Where the reply will show up.
const transcript = (() => {
  const dir = path.join(PROJECTS_DIR, (target.cwd ?? "").replace(/[^a-zA-Z0-9]/g, "-"));
  const p = path.join(dir, `${target.session_id}.jsonl`);
  return fs.existsSync(p) ? p : null;
})();
const sizeBefore = transcript ? fs.statSync(transcript).size : 0;

// Type it, confirm it actually landed, then send Enter. A booting or busy TUI
// silently swallows keystrokes, and a lost Enter looks exactly like a hang.
cmux("send", "--surface", target.surface, "--workspace", target.workspaceRef, message);
await new Promise((r) => setTimeout(r, 1200));
const echoed = cmux("read-screen", "--surface", target.surface, "--workspace", target.workspaceRef);
if (!echoed.includes(message.slice(0, Math.min(24, message.length)))) {
  console.error("The text did not land in the input (session busy or still booting) — nothing was sent.");
  process.exit(1);
}
cmux("send-key", "--surface", target.surface, "--workspace", target.workspaceRef, "enter");
console.error(`→ sent to "${target.title}" (${target.workspace}); waiting up to ${waitSec}s…`);

if (!transcript) {
  console.log("(message delivered; no transcript to read the reply from)");
  process.exit(0);
}

// Poll the transcript tail for assistant text written after our message.
function newAssistantText() {
  const { size } = fs.statSync(transcript);
  if (size <= sizeBefore) return null;
  const fd = fs.openSync(transcript, "r");
  const buf = Buffer.alloc(size - sizeBefore);
  fs.readSync(fd, buf, 0, buf.length, sizeBefore);
  fs.closeSync(fd);
  const out = [];
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.includes('"type":"assistant"')) continue;
    try {
      const o = JSON.parse(line);
      for (const c of o.message?.content ?? []) if (c?.type === "text" && c.text.trim()) out.push(c.text.trim());
    } catch {}
  }
  return out.length ? out : null;
}

const deadline = Date.now() + waitSec * 1000;
let lastLen = 0, stableFor = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 4000));
  const texts = newAssistantText();
  const len = texts ? texts.join("").length : 0;
  // Stop when the reply stops growing — the session may keep using tools between
  // messages, so "no new text for 12s" is a better signal than "any text".
  if (len > 0 && len === lastLen) stableFor += 4; else stableFor = 0;
  lastLen = len;
  if (texts && stableFor >= 12) { console.log(texts.join("\n\n")); process.exit(0); }
  if (Date.now() > deadline) {
    if (texts) { console.log(texts.join("\n\n")); process.exit(0); }
    console.error("No reply within the timeout — the session may still be working.");
    process.exit(3);
  }
}
