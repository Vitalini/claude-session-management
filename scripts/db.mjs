import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DB_PATH = path.join(ROOT, "data", "sessions.db");
// config.example.json holds the defaults; config.json (written by setup.mjs,
// untracked) overrides them key by key, so an older config keeps working when
// new keys appear.
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v;
  }
  return out;
}
export const CONFIG = merge(
  readJson(path.join(ROOT, "config.example.json")),
  readJson(path.join(ROOT, "config.json"))
);

let db;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id     TEXT PRIMARY KEY,
      cwd            TEXT,
      title          TEXT,
      jira_key       TEXT,
      client         TEXT,
      workspace      TEXT,
      status         TEXT DEFAULT 'historical', -- active | saved | historical
      summary        TEXT,
      todos          TEXT,
      resume_command TEXT,
      last_prompt    TEXT,
      first_prompt   TEXT,
      git_branch     TEXT,
      pr_url         TEXT,
      message_count  INTEGER,
      file_mtime     INTEGER,
      file_size      INTEGER,
      created_at     TEXT,
      updated_at     TEXT,
      saved_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_jira ON sessions(jira_key);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      session_id UNINDEXED, title, summary, jira_key, client, cwd, last_prompt,
      content='sessions', content_rowid='rowid', tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
      INSERT INTO sessions_fts(rowid, session_id, title, summary, jira_key, client, cwd, last_prompt)
      VALUES (new.rowid, new.session_id, new.title, new.summary, new.jira_key, new.client, new.cwd, new.last_prompt);
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, session_id, title, summary, jira_key, client, cwd, last_prompt)
      VALUES ('delete', old.rowid, old.session_id, old.title, old.summary, old.jira_key, old.client, old.cwd, old.last_prompt);
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, session_id, title, summary, jira_key, client, cwd, last_prompt)
      VALUES ('delete', old.rowid, old.session_id, old.title, old.summary, old.jira_key, old.client, old.cwd, old.last_prompt);
      INSERT INTO sessions_fts(rowid, session_id, title, summary, jira_key, client, cwd, last_prompt)
      VALUES (new.rowid, new.session_id, new.title, new.summary, new.jira_key, new.client, new.cwd, new.last_prompt);
    END;

    -- Watchdog: what each tab looked like on the previous tick, so a tab going
    -- from running to dead is detectable (that transition is the whole signal).
    CREATE TABLE IF NOT EXISTS tab_state (
      surface       TEXT PRIMARY KEY,
      workspace_ref TEXT,
      workspace     TEXT,
      session_id    TEXT,
      title         TEXT,
      cwd           TEXT,
      was_live      INTEGER DEFAULT 0,
      last_live_at  TEXT,
      usage_pct     INTEGER,
      usage_reset   TEXT,
      warned_at     TEXT,
      updated_at    TEXT
    );

    -- One row per "something happened to a session" event awaiting your call.
    CREATE TABLE IF NOT EXISTS incidents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT,
      surface       TEXT,
      workspace_ref TEXT,
      workspace     TEXT,
      title         TEXT,
      cwd           TEXT,
      kind          TEXT,     -- limit | crash | exit | warning
      detected_at   TEXT,
      reset_at      TEXT,     -- when the usage window frees up, if known
      screen        TEXT,     -- screen excerpt, for forensics
      analysis      TEXT,     -- what this session was doing / what's left
      status        TEXT,     -- pending | resumed | dismissed | snoozed
      decided_at    TEXT,
      decided_via   TEXT,     -- telegram | dashboard
      tg_message_id INTEGER,
      snooze_until  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
  `);
  // Older DBs predate first_prompt; add it and reindex FTS so search sees it.
  const cols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  if (!cols.includes("first_prompt")) {
    db.exec("ALTER TABLE sessions ADD COLUMN first_prompt TEXT");
  }
  const ftsCols = db.prepare("PRAGMA table_info(sessions_fts)").all().map((c) => c.name);
  if (!ftsCols.includes("first_prompt")) {
    db.exec(`
      DROP TRIGGER IF EXISTS sessions_ai;
      DROP TRIGGER IF EXISTS sessions_ad;
      DROP TRIGGER IF EXISTS sessions_au;
      DROP TABLE IF EXISTS sessions_fts;
      CREATE VIRTUAL TABLE sessions_fts USING fts5(
        session_id UNINDEXED, title, summary, jira_key, client, cwd, last_prompt, first_prompt,
        content='sessions', content_rowid='rowid', tokenize='unicode61'
      );
      CREATE TRIGGER sessions_ai AFTER INSERT ON sessions BEGIN
        INSERT INTO sessions_fts(rowid, session_id, title, summary, jira_key, client, cwd, last_prompt, first_prompt)
        VALUES (new.rowid, new.session_id, new.title, new.summary, new.jira_key, new.client, new.cwd, new.last_prompt, new.first_prompt);
      END;
      CREATE TRIGGER sessions_ad AFTER DELETE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, session_id, title, summary, jira_key, client, cwd, last_prompt, first_prompt)
        VALUES ('delete', old.rowid, old.session_id, old.title, old.summary, old.jira_key, old.client, old.cwd, old.last_prompt, old.first_prompt);
      END;
      CREATE TRIGGER sessions_au AFTER UPDATE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, session_id, title, summary, jira_key, client, cwd, last_prompt, first_prompt)
        VALUES ('delete', old.rowid, old.session_id, old.title, old.summary, old.jira_key, old.client, old.cwd, old.last_prompt, old.first_prompt);
        INSERT INTO sessions_fts(rowid, session_id, title, summary, jira_key, client, cwd, last_prompt, first_prompt)
        VALUES (new.rowid, new.session_id, new.title, new.summary, new.jira_key, new.client, new.cwd, new.last_prompt, new.first_prompt);
      END;
      INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild');
    `);
  }
  return db;
}

// ---------- watchdog helpers ----------

export function getTabState(surface) {
  return getDb().prepare("SELECT * FROM tab_state WHERE surface = ?").get(surface);
}

export function allTabStates() {
  return getDb().prepare("SELECT * FROM tab_state").all();
}

export function saveTabState(row) {
  const cols = ["surface", "workspace_ref", "workspace", "session_id", "title", "cwd",
    "was_live", "last_live_at", "usage_pct", "usage_reset", "warned_at", "updated_at"];
  getDb().prepare(
    `INSERT INTO tab_state (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})
     ON CONFLICT(surface) DO UPDATE SET ${cols.filter((c) => c !== "surface").map((c) => `${c} = excluded.${c}`).join(", ")}`
  ).run(Object.fromEntries(cols.map((c) => [c, row[c] ?? null])));
}

export function dropTabState(surface) {
  getDb().prepare("DELETE FROM tab_state WHERE surface = ?").run(surface);
}

export function createIncident(row) {
  const cols = ["session_id", "surface", "workspace_ref", "workspace", "title", "cwd", "kind",
    "detected_at", "reset_at", "screen", "analysis", "status", "tg_message_id"];
  const info = getDb().prepare(
    `INSERT INTO incidents (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`
  ).run(Object.fromEntries(cols.map((c) => [c, row[c] ?? null])));
  return info.lastInsertRowid;
}

export function getIncident(id) {
  return getDb().prepare("SELECT * FROM incidents WHERE id = ?").get(id);
}

export function pendingIncidents() {
  return getDb().prepare(
    `SELECT * FROM incidents WHERE status = 'pending'
        OR (status = 'snoozed' AND (snooze_until IS NULL OR snooze_until <= ?))
     ORDER BY detected_at DESC`
  ).all(new Date().toISOString());
}

export function recentIncidents(limit = 30) {
  return getDb().prepare("SELECT * FROM incidents ORDER BY detected_at DESC LIMIT ?").all(limit);
}

export function updateIncident(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  getDb().prepare(`UPDATE incidents SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`)
    .run({ id, ...fields });
}

// An open incident for this session already exists → don't pile up duplicates.
export function openIncidentFor(sessionId, kind) {
  return getDb().prepare(
    "SELECT * FROM incidents WHERE session_id = ? AND kind = ? AND status IN ('pending','snoozed') LIMIT 1"
  ).get(sessionId, kind);
}

// Usage warnings are account-wide, so one open warning suppresses the rest.
export function openWarning() {
  return getDb().prepare(
    "SELECT * FROM incidents WHERE kind = 'warning' AND status IN ('pending','snoozed') LIMIT 1"
  ).get();
}

const UPSERT_COLS = [
  "cwd", "title", "jira_key", "client", "workspace", "status", "summary", "todos",
  "resume_command", "last_prompt", "first_prompt", "git_branch", "pr_url", "message_count",
  "file_mtime", "file_size", "created_at", "updated_at", "saved_at",
];

// Upsert that only overwrites columns explicitly present in `row` (non-undefined).
export function upsertSession(row) {
  const d = getDb();
  const existing = d.prepare("SELECT * FROM sessions WHERE session_id = ?").get(row.session_id);
  if (!existing) {
    const cols = ["session_id", ...UPSERT_COLS];
    d.prepare(
      `INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`
    ).run(Object.fromEntries(cols.map((c) => [c, row[c] ?? (c === "status" ? "historical" : null)])));
    return "inserted";
  }
  const changed = UPSERT_COLS.filter((c) => row[c] !== undefined && row[c] !== existing[c]);
  if (!changed.length) return "unchanged";
  d.prepare(
    `UPDATE sessions SET ${changed.map((c) => `${c} = @${c}`).join(", ")} WHERE session_id = @session_id`
  ).run({ session_id: row.session_id, ...Object.fromEntries(changed.map((c) => [c, row[c]])) });
  return "updated";
}

export function getSession(sessionId) {
  return getDb().prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
}

// Search: exact jira key first, then FTS, then LIKE fallback. Newest first.
export function searchSessions(q, { limit = 50, status, workspace } = {}) {
  const d = getDb();
  const filters = (prefix = "") =>
    (status ? ` AND ${prefix}status = @status` : "") +
    (workspace ? ` AND ${prefix}workspace = @workspace` : "");
  const params = { limit, status, workspace };
  if (!q) {
    return d.prepare(
      `SELECT * FROM sessions WHERE 1=1${filters()} ORDER BY updated_at DESC LIMIT @limit`
    ).all(params);
  }
  // A bare Jira key means THAT ticket. Its own sessions come first; sessions that
  // merely mention it (a "related tickets" line in a summary) are returned only
  // when it has none, and tagged so callers never resume the wrong ticket's work.
  const key = q.trim().toUpperCase().match(/^[A-Z][A-Z0-9]+-\d+$/)?.[0];
  if (key) {
    const own = d.prepare(
      `SELECT * FROM sessions WHERE jira_key = @key${filters()} ORDER BY updated_at DESC LIMIT @limit`
    ).all({ ...params, key });
    if (own.length) return own.map((r) => ({ ...r, match: "key" }));
    const mentions = d.prepare(
      `SELECT * FROM sessions WHERE (title LIKE @like OR summary LIKE @like
          OR first_prompt LIKE @like OR last_prompt LIKE @like)${filters()}
       ORDER BY updated_at DESC LIMIT @limit`
    ).all({ ...params, like: `%${key}%` });
    return mentions.map((r) => ({ ...r, match: "mention" }));
  }
  // A name you typed at save time should beat any fuzzy match on it.
  const exactTitle = d.prepare(
    `SELECT * FROM sessions WHERE lower(trim(title)) = lower(trim(@q))${filters()}
     ORDER BY updated_at DESC LIMIT @limit`
  ).all({ ...params, q });
  if (exactTitle.length) return exactTitle.map((r) => ({ ...r, match: "name" }));

  const ftsQuery = q.trim().split(/\s+/).map((t) => `"${t.replace(/"/g, "")}"*`).join(" ");
  try {
    const rows = d.prepare(
      `SELECT s.* FROM sessions_fts f JOIN sessions s ON s.rowid = f.rowid
       WHERE sessions_fts MATCH @ftsQuery${filters("s.")}
       ORDER BY s.updated_at DESC LIMIT @limit`
    ).all({ ...params, ftsQuery });
    if (rows.length) return rows;
  } catch { /* bad FTS syntax — fall through to LIKE */ }
  return d.prepare(
    `SELECT * FROM sessions WHERE (title LIKE @like OR summary LIKE @like OR cwd LIKE @like OR first_prompt LIKE @like)${filters()}
     ORDER BY updated_at DESC LIMIT @limit`
  ).all({ ...params, like: `%${q.trim()}%` });
}

// Distinct workspaces present in the DB (for the sidebar), with per-status counts.
export function workspaceCounts() {
  return getDb().prepare(
    `SELECT workspace, status, COUNT(*) n FROM sessions
     WHERE workspace IS NOT NULL GROUP BY workspace, status`
  ).all();
}

export function statusCounts() {
  return getDb().prepare("SELECT status, COUNT(*) n FROM sessions GROUP BY status").all();
}

// Parse "[PS-12345][Client Name] - Title" convention (also tolerates plain titles).
export function parseTabTitle(title) {
  const m = title?.match(/^\[([A-Z][A-Z0-9]+-\d+)\](?:\[([^\]]+)\])?\s*-?\s*(.*)$/);
  if (!m) return { jira_key: title?.match(/\b[A-Z][A-Z0-9]+-\d{3,}\b/)?.[0] ?? null, client: null };
  return { jira_key: m[1], client: m[2] ?? null };
}
