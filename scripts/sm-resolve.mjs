#!/usr/bin/env node
// Resolve a query to a session/action for the `sm` CLI.
// Modes:
//   node sm-resolve.mjs "<query>"          → print plan for current tab:
//       RESUME<TAB>cwd<TAB>session_id   or   PROMPT<TAB>phrase
//   node sm-resolve.mjs --new "<query>"    → open a new cmux tab itself, print what it did
//   node sm-resolve.mjs --list "<query>"   → print a table of matches
//   node sm-resolve.mjs --config           → shell assignments (port, claude flags) for the `sm` wrapper

import { searchSessions, getSession, CONFIG } from "./db.mjs";
import { resumeSessionTab, openTab, focusTab } from "./cmux-lib.mjs";
import { liveScan } from "./index-sessions.mjs";

const args = process.argv.slice(2);
const mode = args[0]?.startsWith("--") ? args.shift().slice(2) : "resolve";
const rawQuery = args.join(" ").trim();

const info = (...a) => console.error(...a);

if (mode === "config") {
  const shq = (v) => `'${String(v ?? "").replace(/'/g, `'\\''`)}'`;
  console.log(`SM_PORT=${shq(CONFIG.port || 3737)}`);
  console.log(`SM_CLAUDE_FLAGS_DEFAULT=${shq(CONFIG.claudeFlags ?? "")}`);
  process.exit(0);
}

// Jira is optional: with no base URL the phrases get the bare key instead of a link.
const JIRA_BASE = (CONFIG.jira?.baseUrl ?? "").replace(/\/+$/, "");
const ticketRef = (key) => (JIRA_BASE ? `${JIRA_BASE}/browse/${key}` : key);

// A pasted Jira link is just a key with decoration — treat them the same.
function normalize(q) {
  const fromUrl = q.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i)?.[1]
    ?? q.match(/[?&]selectedIssue=([A-Z][A-Z0-9]+-\d+)/i)?.[1];
  return (fromUrl ?? q).trim();
}
const query = normalize(rawQuery);
if (query !== rawQuery) info(`Jira link → ${query}`);

function fmtRow(s) {
  const date = (s.updated_at ?? "").slice(0, 10);
  const st = s.status.padEnd(10);
  const key = (s.jira_key ?? "").padEnd(9);
  return `${date}  ${st} ${key} ${(s.title ?? "").slice(0, 70)}`;
}

async function jiraIssue(key) {
  const { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_BASE || !JIRA_EMAIL || !JIRA_API_TOKEN) return null;
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  try {
    const res = await fetch(
      `${JIRA_BASE}/rest/api/3/issue/${key}?fields=summary,labels,issuetype`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// Decide the phrase for a ticket with no saved session.
async function ticketPlan(key) {
  const issue = await jiraIssue(key);
  let scoping = false;
  if (issue) {
    const summary = issue.fields?.summary ?? "";
    const labels = (issue.fields?.labels ?? []).join(" ");
    scoping = /scop/i.test(summary) || /scop/i.test(labels);
    info(`Jira: ${key} — ${summary}${scoping ? "  [scoping]" : ""}`);
  } else if (JIRA_BASE) {
    info(`Jira: ${key} — could not read the ticket (no access/creds), using the default phrase`);
  }
  const phrase = (scoping ? CONFIG.phrases.scoping : CONFIG.phrases.task).replace("{url}", ticketRef(key));
  return { phrase, scoping };
}

if (mode === "list") {
  const rows = searchSessions(query, { limit: 25 });
  if (!rows.length) { info("Nothing found."); process.exit(1); }
  for (const r of rows) console.log(fmtRow(r));
  process.exit(0);
}

const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query);
const jiraKey = query.toUpperCase().match(/^[A-Z][A-Z0-9]+-\d+$/)?.[0];
const found = isUuid ? getSession(query.toLowerCase()) : searchSessions(query, { limit: 1 })[0];
// A session that only mentions the ticket is not that ticket's session: resuming
// it would drop you into unrelated work and tell it to check the wrong ticket.
const mentionOnly = found?.match === "mention";
const hit = mentionOnly ? null : found;
if (mentionOnly) {
  info(`No session for ${jiraKey} yet. It is only mentioned in "${found.title ?? found.session_id}" — not resuming that one.`);
}

// A session that is already running gets switched to, never resumed again:
// two claudes on one transcript would fight over it.
function liveTabFor(sessionId) {
  try {
    return (liveScan()?.tabs ?? []).find((t) => t.session_id === sessionId) ?? null;
  } catch { return null; }
}

if (hit?.cwd) {
  info(`Found session: [${hit.status}] ${hit.title ?? hit.session_id} (${hit.updated_at?.slice(0, 10)})`);

  const openTabRef = hit.status === "active" ? liveTabFor(hit.session_id) : null;
  if (openTabRef) {
    info(`Session is already open in ${openTabRef.workspace} — switching to its tab, not starting a second one.`);
    focusTab({ workspace: openTabRef.workspaceRef, surface: openTabRef.surface });
    console.log(`FOCUSED\t${openTabRef.workspace}\t${openTabRef.title}`);
    process.exit(0);
  }
  // Resuming a ticket's session: hand it the ticket link so it re-reads what
  // changed there while it was parked, instead of waking up mid-thought.
  const key = jiraKey ?? hit.jira_key;
  const prompt = key ? CONFIG.phrases.updates.replace("{url}", ticketRef(key)) : "";
  if (prompt) info(`Kickoff: ${prompt}`);
  if (mode === "new") {
    const r = resumeSessionTab(hit.session_id, { focus: true, prompt });
    console.log(`OPENED\t${r.workspace}\t${r.surface ?? ""}`);
  } else {
    console.log(`RESUME\t${hit.cwd}\t${hit.session_id}\t${prompt}`);
  }
  process.exit(0);
}

if (!jiraKey) {
  info(`No session matches "${query}" (and it is not a Jira key).`);
  info(`Try: sm -l "${query}" to see near matches.`);
  process.exit(1);
}

const { phrase, scoping } = await ticketPlan(jiraKey);
if (mode === "new") {
  const r = openTab({
    workspaceName: scoping ? (CONFIG.scopingWorkspace || CONFIG.defaultWorkspace) : CONFIG.defaultWorkspace,
    cwd: process.env.HOME,
    command: `claude ${CONFIG.claudeFlags} '${phrase.replace(/'/g, `'\\''`)}'`,
    title: jiraKey,
    focus: true,
  });
  console.log(`OPENED\t${r.workspace}\t${r.surface ?? ""}`);
} else {
  console.log(`PROMPT\t${phrase}`);
}
