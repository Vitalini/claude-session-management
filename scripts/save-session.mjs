#!/usr/bin/env node
// Save the CURRENT Claude session to the DB (cold storage), then optionally
// close the cmux tab it runs in. Meant to be executed from inside the session
// being saved (the /sm command and the session-management skill call this).
//
//   node save-session.mjs --summary "what got done" [--name "short human name"] [--todos "what is left"] [--exit | --close]
//
// The tab is only closed when this process can PROVE which tab it lives in —
// closing a tab is destructive, and a wrong guess would kill someone else's work.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { upsertSession, parseTabTitle, CONFIG } from "./db.mjs";
import { cmux, listWorkspaces, callerTab, ownClaudeProcess } from "./cmux-lib.mjs";

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
}
const summary = opt("summary");
const todos = opt("todos");
// Short human-readable name — becomes the stored title so the session can be
// found later with `sm "<name>"` instead of a session id.
const name = opt("name");
const doClose = args.includes("--close");
// --exit: end the claude session but keep the tab (shell stays). Sent as "/exit"
// into our own tab so claude shuts down cleanly once this turn finishes.
const doExit = args.includes("--exit") && !doClose;

// Newest transcript for a directory — the fallback session id for a claude
// that was started fresh (no --resume in its argv) outside a bound tab.
function newestSessionFor(cwd) {
  const dir = path.join(CONFIG.claudeProjectsDir.replace(/^~/, os.homedir()), cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  let newest = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const st = fs.statSync(path.join(dir, f));
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { id: path.basename(f, ".jsonl"), mtimeMs: st.mtimeMs };
    }
  } catch {}
  return newest?.id ?? null;
}

// 1. Which tab are we in (if any) and what is our session?
const tab = callerTab();
const own = tab?.own ?? ownClaudeProcess();
const cwd = process.cwd();

let sessionId = own.sessionId;
let resumeCmd = null, title = null, wsName = null;

if (tab) {
  try {
    const out = cmux("surface", "resume", "get", "--surface", tab.surface, "--workspace", tab.workspace);
    if (!/^No resume/i.test(out)) resumeCmd = out;
  } catch {}
  const boundId = resumeCmd?.match(/--resume\D{0,10}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1] ?? null;
  sessionId ??= boundId;
  if (boundId !== sessionId) resumeCmd = null; // stale binding — don't record it
  try {
    title = cmux("tree", "--workspace", tab.workspace)
      .match(new RegExp(`surface ${tab.surface} \\[terminal\\] "([^"]*)"`))?.[1] ?? null;
  } catch {}
  wsName = listWorkspaces().find((w) => w.ref === tab.workspace)?.name ?? null;
}

sessionId ??= newestSessionFor(cwd);
if (!sessionId) {
  console.error("Cannot determine this session's id — nothing to save.");
  console.error("Check: was claude started with --resume, and is there a transcript in ~/.claude/projects for", cwd);
  process.exit(1);
}

// 2. Save.
const fromTitle = parseTabTitle(title);
const now = new Date().toISOString();
upsertSession({
  session_id: sessionId,
  cwd,
  title: name || title || undefined,
  jira_key: fromTitle.jira_key ?? undefined,
  client: fromTitle.client ?? undefined,
  workspace: wsName ?? undefined,
  status: "saved",
  summary,
  todos,
  resume_command: resumeCmd ?? undefined,
  updated_at: now,
  saved_at: now,
});

console.log(`✔ Session saved: ${sessionId}`);
console.log(`  Title: ${name ?? title ?? "(untitled)"}`);
console.log(`  Folder: ${cwd}`);
console.log(`  Workspace: ${wsName ?? "-"}${fromTitle.jira_key ? `  Ticket: ${fromTitle.jira_key}` : ""}`);
// Restore hint: the ticket key when there is one, else the human name/title (FTS
// finds it), never a raw id unless there is nothing else to search by. A session
// with no ticket is found by its name — ticket tracking is optional.
const handle = fromTitle.jira_key ?? name ?? title;
console.log(`  Come back with: sm ${handle ? (fromTitle.jira_key ? handle : JSON.stringify(handle)) : sessionId}`);
if (!handle) console.log("  (no ticket key or --name given — only the session id can find this one; pass --name next time)");

// 3a. Exit the session, keep the tab.
if (doExit) {
  if (tab) {
    console.log("Exiting claude (tab stays open)…");
    cmux("send", "--surface", tab.surface, "--workspace", tab.workspace, "/exit");
    cmux("send-key", "--surface", tab.surface, "--workspace", tab.workspace, "enter");
  } else {
    // No cmux tab: fall back to signalling the nearest claude ancestor.
    let pid = process.ppid;
    for (let i = 0; i < 6 && pid > 1; i++) {
      const [ppid, comm] = execFileSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)]).toString().trim().split(/\s+/, 2);
      if (/claude$/.test(comm ?? "")) { console.log(`Exiting claude (pid ${pid})…`); process.kill(pid, "SIGTERM"); break; }
      pid = Number(ppid);
    }
  }
  process.exit(0);
}

// 3b. Close the tab — last, because it kills this process tree.
if (!doClose) process.exit(0);
if (!tab) {
  console.log("");
  console.log("⚠ Could not prove which cmux tab this session runs in —");
  console.log("  the tab was NOT closed (closing a guess would kill someone else's work). Close it yourself: Cmd+W.");
  console.log("  The session is saved; you can come back to it as usual.");
  process.exit(0);
}
console.log(`Closing the tab (${tab.via})…`);
cmux("close-surface", "--surface", tab.surface, "--workspace", tab.workspace);
