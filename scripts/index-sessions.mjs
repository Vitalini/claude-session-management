#!/usr/bin/env node
// Index Claude sessions into SQLite: backfill from ~/.claude/projects + live scan of cmux tabs.
// Usage: node index-sessions.mjs [--backfill] [--live] (default: both)

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { getDb, upsertSession, statusCounts, parseTabTitle, searchSessions, CONFIG } from "./db.mjs";
import { cmux, claudeProcessesBySurface } from "./cmux-lib.mjs";

const PROJECTS_DIR = CONFIG.claudeProjectsDir.replace(/^~/, os.homedir());
const JIRA_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{2,6}\b/g;

// ---------- Backfill from jsonl transcripts ----------

async function indexJsonl(file, stat) {
  const sessionId = path.basename(file, ".jsonl");
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let cwd, gitBranch, createdAt, updatedAt, aiTitle, lastPrompt, prUrl, firstUserText;
  const openers = []; // first few human messages, to pick a telling one from
  // Harness plumbing that arrives as "user" text but nobody typed.
  const isPlumbing = (t) =>
    /^(Base directory for this skill|Caveat:|Last login:|\[SYSTEM|<command-|<local-command|<user-prompt|<system-reminder)/i.test(t.trim());
  let userCount = 0;
  const jiraHits = new Map();

  const noteKeys = (s) => {
    for (const k of String(s).matchAll(JIRA_KEY_RE)) jiraHits.set(k[0], (jiraHits.get(k[0]) ?? 0) + 1);
  };

  for await (const line of rl) {
    // Cheap substring routing before JSON.parse — assistant lines dominate size and are skipped.
    if (line.includes('"type":"ai-title"')) {
      try { aiTitle = JSON.parse(line).aiTitle ?? aiTitle; noteKeys(aiTitle); } catch {}
    } else if (line.includes('"type":"last-prompt"')) {
      try { lastPrompt = JSON.parse(line).lastPrompt ?? lastPrompt; } catch {}
    } else if (line.includes('"type":"pr-link"')) {
      try { prUrl = JSON.parse(line).prUrl ?? prUrl; } catch {}
    } else if (line.includes('"type":"summary"')) {
      try { const o = JSON.parse(line); if (o.summary) { aiTitle ??= o.summary; noteKeys(o.summary); } } catch {}
    } else if (line.includes('"type":"user"')) {
      userCount++;
      try {
        const o = JSON.parse(line);
        cwd ??= o.cwd; gitBranch = o.gitBranch ?? gitBranch;
        createdAt ??= o.timestamp; if (o.timestamp) updatedAt = o.timestamp;
        const c = o.message?.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((p) => p.type === "text")?.text : null;
        if (text && !text.startsWith("<") && !isPlumbing(text)) {
          firstUserText ??= text.slice(0, 200);
          if (openers.length < 6) openers.push(text);
          if (userCount <= 50) noteKeys(text.slice(0, 2000));
        }
      } catch {}
    } else if (!cwd && line.includes('"cwd":')) {
      try { const o = JSON.parse(line); cwd ??= o.cwd; createdAt ??= o.timestamp; } catch {}
    }
  }

  // Sessions opened by `sm` start with a kickoff phrase plus a Jira link, which
  // says nothing about the work. Show the first message that actually does.
  const opener = openers.find((t) => {
    const meat = t.replace(/https?:\/\/\S+/g, "").replace(/\[Image #\d+\]/g, "").trim();
    return meat.length >= 25;
  }) ?? openers[0] ?? firstUserText;

  const title = aiTitle || firstUserText || path.basename(cwd ?? "");
  const fromTitle = parseTabTitle(title);
  const topHit = [...jiraHits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  upsertSession({
    session_id: sessionId,
    cwd, title,
    jira_key: fromTitle.jira_key ?? topHit ?? null,
    client: fromTitle.client,
    last_prompt: lastPrompt,
    first_prompt: opener?.replace(/\s+/g, " ").trim().slice(0, 240) ?? null,
    git_branch: gitBranch,
    pr_url: prUrl,
    message_count: userCount,
    file_mtime: Math.floor(stat.mtimeMs),
    file_size: stat.size,
    created_at: createdAt,
    updated_at: updatedAt ?? createdAt ?? new Date(stat.mtimeMs).toISOString(),
  });
}

export async function backfill(force = false) {
  const db = getDb();
  const known = new Map(
    db.prepare("SELECT session_id, file_mtime, file_size FROM sessions").all()
      .map((r) => [r.session_id, r])
  );
  let scanned = 0, skipped = 0;
  for (const dir of fs.readdirSync(PROJECTS_DIR)) {
    const full = path.join(PROJECTS_DIR, dir);
    let files;
    try { files = fs.readdirSync(full).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const file = path.join(full, f);
      const stat = fs.statSync(file);
      const prev = known.get(path.basename(f, ".jsonl"));
      const unchanged = prev && prev.file_mtime === Math.floor(stat.mtimeMs) && prev.file_size === stat.size;
      if (unchanged && !force) { skipped++; continue; }
      await indexJsonl(file, stat);
      scanned++;
    }
  }
  console.error(`backfill: indexed ${scanned}, unchanged ${skipped}`);
}

// ---------- Live scan of cmux ----------

// Ground truth for LIVE surfaces, straight from the running claude process:
// session id from its `--resume <uuid>` argv (a tab's resume binding can point
// at a previous session), cwd via lsof, else newest transcript in that cwd.
// Returns Map<surfaceRef, {sessionId, cwd}>.
function sessionsFromPids(claudeBySurface) {
  const result = new Map();
  if (!claudeBySurface.size) return result;
  const pids = [...claudeBySurface.values()];

  const resumeArgByPid = new Map();
  try {
    const psOut = execFileSync("/bin/ps", ["-o", "pid=,args=", "-p", pids.join(",")], { encoding: "utf8" });
    for (const line of psOut.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      const rid = m[2].match(/--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1];
      if (rid) resumeArgByPid.set(m[1], rid);
    }
  } catch {}

  let lsofOut = "";
  try {
    lsofOut = execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], { encoding: "utf8" });
  } catch (e) { lsofOut = e.stdout ?? ""; }
  const cwdByPid = new Map();
  let curPid = null;
  for (const line of lsofOut.split("\n")) {
    if (line.startsWith("p")) curPid = line.slice(1);
    else if (line.startsWith("n") && curPid) cwdByPid.set(curPid, line.slice(1));
  }

  for (const [surf, pid] of claudeBySurface) {
    const cwd = cwdByPid.get(pid) ?? null;
    let sessionId = resumeArgByPid.get(pid) ?? null;
    if (!sessionId && cwd) {
      const projDir = path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      let newest = null;
      try {
        for (const f of fs.readdirSync(projDir)) {
          if (!f.endsWith(".jsonl")) continue;
          const st = fs.statSync(path.join(projDir, f));
          if (!newest || st.mtimeMs > newest.mtimeMs) newest = { id: path.basename(f, ".jsonl"), mtimeMs: st.mtimeMs };
        }
      } catch {}
      sessionId = newest?.id ?? null;
    }
    if (sessionId) result.set(surf, { sessionId, cwd });
  }
  return result;
}

// cmux's session-state file records each tab's working directory (survives
// reboots, unlike ttys/processes). Returns Map<title, Set<workingDirectory>>.
function tabDirsFromSessionFile() {
  const map = new Map();
  const file = path.join(os.homedir(), "Library/Application Support/cmux/session-com.cmuxterm.app.json");
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return map; }
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== "object") return;
    if (o.terminal?.workingDirectory && typeof o.title === "string") {
      if (!map.has(o.title)) map.set(o.title, new Set());
      map.get(o.title).add(o.terminal.workingDirectory);
    }
    Object.values(o).forEach(walk);
  })(data);
  return map;
}

// Guess the session for a dead, unbound tab from its recorded working dir:
// prefer a title match living in that dir; else, if the dir is dedicated
// (few sessions), take its newest one. Shared hubs with no title match → null,
// better no Wake button than waking the wrong session.
function guessByDir(tabTitle, wd) {
  const hit = searchSessions(tabTitle, { limit: 5 }).find((h) => h.cwd === wd);
  if (hit) return { session_id: hit.session_id, cwd: wd };
  const db = getDb();
  const n = db.prepare("SELECT COUNT(*) n FROM sessions WHERE cwd = ?").get(wd).n;
  if (n >= 1 && n <= 4) {
    const newest = db.prepare("SELECT session_id FROM sessions WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1").get(wd);
    if (newest) return { session_id: newest.session_id, cwd: wd };
  }
  return null;
}

export function liveScan() {
  let tree;
  try { tree = cmux("tree", "--all"); } catch (e) {
    console.error("live: cmux unreachable, skipping —", e.message.split("\n")[0]);
    return null;
  }
  const activeIds = new Set();
  const tabs = [];
  const workspaces = []; // in cmux sidebar (tree) order
  let wsRef = null, wsName = null;
  const parsed = [];
  for (const line of tree.split("\n")) {
    const ws = line.match(/workspace (workspace:\d+) "([^"]*)"/);
    if (ws) { wsRef = ws[1]; wsName = ws[2]; workspaces.push({ ref: wsRef, name: wsName }); continue; }
    const surf = line.match(/surface (surface:\d+) \[terminal\] "([^"]*)"/);
    if (!surf || !wsRef) continue;
    parsed.push({ surfRef: surf[1], tabTitle: surf[2], wsRef, wsName });
  }
  const claudeBySurface = claudeProcessesBySurface();
  const fallbackBySurface = sessionsFromPids(claudeBySurface);
  const tabDirs = tabDirsFromSessionFile();

  for (const { surfRef, tabTitle, wsRef, wsName } of parsed) {
    const claudeRunning = claudeBySurface.has(surfRef);
    // Binding = what cmux would resume in this tab. Can go stale (previous session).
    let resumeCmd = null, bindingId = null, bindingCwd;
    try { resumeCmd = cmux("surface", "resume", "get", "--surface", surfRef, "--workspace", wsRef); } catch {}
    if (!resumeCmd || resumeCmd === "No resume binding") {
      resumeCmd = null;
    } else {
      bindingId = resumeCmd.match(/--resume\D{0,10}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1] ?? null;
      bindingCwd = resumeCmd.match(/^cd -- '(.*?)' 2>\/dev\/null/)?.[1]?.replace(/'\\''/g, "'");
    }

    let sessionId = null, cwd, dbSession = null;
    if (claudeRunning) {
      // Live tab: the process itself is the truth; binding only as fallback.
      const proc = fallbackBySurface.get(surfRef);
      sessionId = proc?.sessionId ?? bindingId;
      cwd = proc?.cwd ?? bindingCwd;
      if (sessionId !== bindingId) resumeCmd = null; // stale binding — don't record it
    } else if (bindingId) {
      // Claude exited but the tab remembers its session → wake in place.
      dbSession = { session_id: bindingId, cwd: bindingCwd ?? null };
    } else {
      // Dead tab, no binding: match the leftover title against the DB —
      // by Jira key first, then via the tab's recorded working directory.
      const key = parseTabTitle(tabTitle).jira_key;
      if (key) {
        const hit = searchSessions(key, { limit: 1 })[0];
        if (hit?.cwd) dbSession = { session_id: hit.session_id, cwd: hit.cwd };
      }
      if (!dbSession) {
        const wds = tabDirs.get(tabTitle);
        if (wds?.size === 1) dbSession = guessByDir(tabTitle, [...wds][0]);
      }
    }
    tabs.push({
      session_id: sessionId, surface: surfRef, workspaceRef: wsRef, workspace: wsName,
      title: tabTitle, cwd: cwd ?? null,
      db_session_id: dbSession?.session_id ?? null, db_cwd: dbSession?.cwd ?? null,
    });
    if (!sessionId) continue;
    activeIds.add(sessionId);
    const fromTitle = parseTabTitle(tabTitle);
    upsertSession({
      session_id: sessionId,
      cwd,
      title: tabTitle || undefined,
      jira_key: fromTitle.jira_key ?? undefined,
      client: fromTitle.client ?? undefined,
      workspace: wsName,
      status: "active",
      resume_command: resumeCmd,
      updated_at: new Date().toISOString(),
    });
  }
  // Sessions we thought active but no longer open → saved (cold).
  const db = getDb();
  const stale = db.prepare("SELECT session_id FROM sessions WHERE status = 'active'").all()
    .filter((r) => !activeIds.has(r.session_id));
  const mark = db.prepare("UPDATE sessions SET status = 'saved', saved_at = ? WHERE session_id = ?");
  for (const r of stale) mark.run(new Date().toISOString(), r.session_id);
  console.error(`live: ${activeIds.size} active tabs, ${stale.length} moved to saved`);
  return { tabs, workspaces };
}

// ---------- Main (only when run directly — the watchdog imports liveScan) ----------

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const doBackfill = args.includes("--backfill") || !args.some((a) => a !== "--json");
  const doLive = args.includes("--live") || !args.some((a) => a !== "--json");

  if (doBackfill) await backfill(args.includes("--force"));
  const live = doLive ? liveScan() : null;
  if (json) console.log(JSON.stringify({ tabs: live?.tabs ?? null, workspaces: live?.workspaces ?? null, counts: statusCounts() }));
  else console.log("counts:", statusCounts().map((r) => `${r.status}=${r.n}`).join(" "));
}
