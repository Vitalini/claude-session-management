// Shared cmux helpers: open a session tab in the right workspace, focus tabs,
// hibernate (save + close) live tabs.
import { execFileSync } from "node:child_process";
import { CONFIG, getSession, upsertSession, parseTabTitle } from "./db.mjs";
import { detectCmuxBin } from "./cmux-detect.mjs";

export { detectCmuxBin };

// The cmux CLI: config.cmuxBin when set, otherwise the same auto-detection
// setup.mjs uses (the app bundle first, then PATH).
export const CMUX_BIN = CONFIG.cmuxBin || detectCmuxBin() || "cmux";

// Workspace new tabs land in when neither the session nor the config names one.
export const FALLBACK_WORKSPACE = "Sessions";

export function cmux(...args) {
  return execFileSync(CMUX_BIN, args, {
    encoding: "utf8",
    env: { ...process.env, CMUX_QUIET: "1" },
    timeout: 15000,
  }).trim();
}

export function listWorkspaces() {
  // "  workspace:18  Some Name" / "* workspace:3  Projects  [selected]"
  return cmux("workspace", "list").split("\n").map((l) => {
    const m = l.match(/(workspace:\d+)\s+(.+?)(?:\s+\[selected\])?\s*$/);
    return m ? { ref: m[1], name: m[2].trim() } : null;
  }).filter(Boolean);
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Open a new cmux tab running `command` in `cwd`, inside the workspace named
// `workspaceName` (created if missing). Returns {workspace, surface}.
export function openTab({ workspaceName, cwd, command, title, focus = true }) {
  const name = workspaceName || CONFIG.defaultWorkspace || FALLBACK_WORKSPACE;
  const ws = listWorkspaces().find((w) => w.name.toLowerCase() === name.toLowerCase());
  const full = `cd ${shq(cwd)} && ${command}`;
  let wsRef, surfRef;
  if (!ws) {
    wsRef = cmux("new-workspace", "--name", name, "--cwd", cwd, "--command", command,
      "--focus", String(focus)).match(/workspace:\d+/)?.[0];
  } else {
    wsRef = ws.ref;
    const out = cmux("new-surface", "--type", "terminal", "--workspace", wsRef, "--focus", String(focus));
    surfRef = out.match(/surface:\d+/)?.[0];
    cmux("send", "--surface", surfRef, "--workspace", wsRef, full);
    cmux("send-key", "--surface", surfRef, "--workspace", wsRef, "enter");
  }
  if (title && surfRef) {
    try { cmux("rename-tab", "--surface", surfRef, "--workspace", wsRef, title); } catch {}
  }
  if (focus) {
    try { cmux("select-workspace", "--workspace", wsRef); } catch {}
    try { execFileSync("open", ["-a", "cmux"]); } catch {}
  }
  return { workspace: wsRef, surface: surfRef ?? null };
}

// Resume a saved Claude session in a new tab. Throws if session unknown.
// `prompt` is handed to claude as its first message (e.g. "check what changed
// on the ticket"), so the session wakes up pointed at something.
export function resumeSessionTab(sessionId, { focus = true, prompt = "" } = {}) {
  const row = getSession(sessionId);
  if (!row) throw new Error(`session not found in DB: ${sessionId}`);
  if (!row.cwd) throw new Error(`session has no cwd recorded: ${sessionId}`);
  return openTab({
    workspaceName: row.workspace,
    cwd: row.cwd,
    command: `claude ${CONFIG.claudeFlags} --resume ${shq(sessionId)}` + (prompt ? ` ${shq(prompt)}` : ""),
    title: row.title,
    focus,
  });
}

// The tab the user is currently looking at in cmux.
export function focusedTab() {
  const id = JSON.parse(cmux("identify", "--no-caller"));
  return id.focused ?? null;
}

// cmux's own view of which processes belong to which tab. A running claude
// renames itself to its version string ("2.1.223"), so match both forms.
// Returns Map<surfaceRef, pid>.
export function claudeProcessesBySurface() {
  let rows;
  try {
    rows = cmux("top", "--all", "--processes", "--format", "tsv")
      .split("\n").map((l) => l.split("\t")).filter((c) => c[3] === "process");
  } catch { return new Map(); }
  const parentOf = new Map(rows.map((c) => [c[4], c[5]]));
  const surfaceOf = (pid) => {
    let p = pid;
    for (let depth = 0; p && depth < 25; depth++) {
      const par = parentOf.get(p);
      if (!par) return null;
      if (par.startsWith("surface:")) return par;
      if (par.startsWith("window:")) return null;
      p = par;
    }
    return null;
  };
  const map = new Map();
  for (const c of rows) {
    const name = c[6] ?? "";
    if (name === "claude" || /^\d+\.\d+\.\d+$/.test(name)) {
      const s = surfaceOf(c[4]);
      if (s && !map.has(s)) map.set(s, c[4]);
    }
  }
  return map;
}

// The claude process THIS script runs under: its pid and the session id from
// its own argv (`--resume <uuid>`). The argv is authoritative — a tab's resume
// binding can point at a session that tab ran previously.
export function ownClaudeProcess() {
  let cur = String(process.pid);
  for (let i = 0; i < 12 && cur && cur !== "1"; i++) {
    let args = "";
    try { args = execFileSync("/bin/ps", ["-o", "args=", "-p", cur], { encoding: "utf8" }).trim(); } catch { break; }
    if (/(^|\/)claude(\s|$)/.test(args)) {
      const sessionId = args.match(/--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1] ?? null;
      return { pid: cur, sessionId };
    }
    try { cur = execFileSync("/bin/ps", ["-o", "ppid=", "-p", cur], { encoding: "utf8" }).trim(); } catch { break; }
  }
  return { pid: null, sessionId: null };
}

export function workspaceForSurface(surface) {
  for (const ws of listWorkspaces()) {
    try {
      if (cmux("tree", "--workspace", ws.ref).includes(`surface ${surface} `)) return ws.ref;
    } catch {}
  }
  return null;
}

// The cmux tab THIS process runs in — only reported when it can be PROVEN,
// since the caller may close it. Proof is either cmux's own caller attribution,
// or cmux attributing our claude pid to that tab. A session running outside
// cmux's tracked surfaces correctly yields null rather than someone else's tab.
export function callerTab() {
  const own = ownClaudeProcess();
  try {
    const id = JSON.parse(cmux("identify"));
    if (id.caller?.surface_ref && id.caller?.workspace_ref) {
      return { surface: id.caller.surface_ref, workspace: id.caller.workspace_ref, via: "identify", own };
    }
  } catch {}

  if (own.pid) {
    for (const [surface, pid] of claudeProcessesBySurface()) {
      if (pid === own.pid) {
        const ws = workspaceForSurface(surface);
        if (ws) return { surface, workspace: ws, via: "process-tree", own };
      }
    }
  }
  return null;
}

// Save a live tab's Claude session to the DB and close the tab (freeing RAM).
// Works on ANY tab by surface/workspace ref — not just the caller.
// For tabs without a cmux resume binding, pass sessionIdHint/cwdHint
// (the live scan detects them via tty → claude process → newest transcript).
export function hibernateTab({ surface, workspace, sessionIdHint, cwdHint }) {
  let resumeCmd = cmux("surface", "resume", "get", "--surface", surface, "--workspace", workspace);
  if (!resumeCmd || /^No resume/i.test(resumeCmd)) resumeCmd = null;
  const sessionId =
    resumeCmd?.match(/--resume\D{0,10}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1] ??
    sessionIdHint;
  if (!sessionId) throw new Error("This tab has no claude session (resume binding) — nothing to hibernate.");
  const cwd = resumeCmd?.match(/^cd -- '(.*?)' 2>\/dev\/null/)?.[1]?.replace(/'\\''/g, "'") ?? cwdHint;

  let title;
  try {
    const tree = cmux("tree", "--workspace", workspace);
    title = tree.match(new RegExp(`surface ${surface} \\[terminal\\] "([^"]*)"`))?.[1];
  } catch {}
  const wsName = listWorkspaces().find((w) => w.ref === workspace)?.name ?? null;
  const fromTitle = parseTabTitle(title);

  const now = new Date().toISOString();
  upsertSession({
    session_id: sessionId,
    cwd,
    title: title || undefined,
    jira_key: fromTitle.jira_key ?? undefined,
    client: fromTitle.client ?? undefined,
    workspace: wsName ?? undefined,
    status: "saved",
    resume_command: resumeCmd ?? undefined,
    updated_at: now,
    saved_at: now,
  });
  cmux("close-surface", "--surface", surface, "--workspace", workspace);
  return { session_id: sessionId, title: title ?? null, workspace: wsName };
}

// Wake a session inside an ALREADY-OPEN tab (an idle shell whose claude exited):
// types `cd <cwd> && claude --resume <id>` into that surface and focuses it.
export function wakeInTab({ surface, workspace, sessionId, cwd }) {
  const full = `cd ${shq(cwd)} && claude ${CONFIG.claudeFlags} --resume ${shq(sessionId)}`;
  cmux("send", "--surface", surface, "--workspace", workspace, full);
  cmux("send-key", "--surface", surface, "--workspace", workspace, "enter");
  focusTab({ workspace, surface });
  return { surface, workspace };
}

// Bring an already-open tab to front (focus-panel is cmux's surface-focus alias).
export function focusTab({ workspace, surface }) {
  if (workspace) try { cmux("select-workspace", "--workspace", workspace); } catch {}
  if (surface && workspace) {
    try { cmux("focus-panel", "--panel", surface, "--workspace", workspace); } catch {}
  }
  try { execFileSync("open", ["-a", "cmux"]); } catch {}
}
