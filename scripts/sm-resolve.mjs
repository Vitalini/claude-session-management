#!/usr/bin/env node
// Resolve a query to a session/action for the `sm` CLI.
// Modes:
//   node sm-resolve.mjs "<query>"          → print plan for current tab:
//       RESUME<TAB>cwd<TAB>session_id   or   PROMPT<TAB>phrase
//   node sm-resolve.mjs --new "<query>"    → open a new cmux tab itself, print what it did
//   node sm-resolve.mjs --list "<query>"   → print a table of matches
//   node sm-resolve.mjs --config           → shell assignments (port, claude flags) for the `sm` wrapper

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchSessions, getSession, CONFIG } from "./db.mjs";
import { ticketsEnabled, ticketBaseUrl, bareKeyExact, ticketUrl, keyFromUrl } from "./tickets.mjs";
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

// Ticket tracking is optional: with it off the phrases get the bare key instead
// of a link, and nothing ever calls the tracker.
const ticketRef = (key) => ticketUrl(key) ?? key;

// A pasted ticket link is just a key with decoration — treat them the same.
const query = keyFromUrl(rawQuery) ?? rawQuery;
if (query !== rawQuery) info(`Ticket link → ${query}`);

function fmtRow(s) {
  const date = (s.updated_at ?? "").slice(0, 10);
  const st = s.status.padEnd(10);
  const key = (s.jira_key ?? "").padEnd(9);
  return `${date}  ${st} ${key} ${(s.title ?? "").slice(0, 70)}`;
}

// Optional enrichment for the typical case (a Jira-compatible tracker): read the
// ticket so a scoping ticket gets the scoping phrase. Skipped entirely when
// ticket tracking is off — no network call, no credentials needed.
async function ticketIssue(key) {
  if (!ticketsEnabled()) return null;
  const email = process.env.TICKET_EMAIL ?? process.env.JIRA_EMAIL;
  const token = process.env.TICKET_API_TOKEN ?? process.env.JIRA_API_TOKEN;
  const base = ticketBaseUrl();
  if (!base || !email || !token) return null;
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  try {
    const res = await fetch(
      `${base}/rest/api/3/issue/${key}?fields=summary,labels,issuetype`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// Decide the phrase for a ticket with no saved session.
async function ticketPlan(key) {
  const issue = await ticketIssue(key);
  let scoping = false;
  if (issue) {
    const summary = issue.fields?.summary ?? "";
    const labels = (issue.fields?.labels ?? []).join(" ");
    scoping = /scop/i.test(summary) || /scop/i.test(labels);
    info(`Ticket: ${key} — ${summary}${scoping ? "  [scoping]" : ""}`);
  } else if (ticketsEnabled()) {
    info(`Ticket: ${key} — could not read it (no access/creds), using the default phrase`);
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
// bareKeyExact, not ticketKeyExact: a bare PROJ-123 still earns a kickoff phrase
// with tracking off — it just carries the key instead of a link.
const ticketKey = bareKeyExact(query);
const found = isUuid ? getSession(query.toLowerCase()) : searchSessions(query, { limit: 1 })[0];
// A session that only mentions the ticket is not that ticket's session: resuming
// it would drop you into unrelated work and tell it to check the wrong ticket.
const mentionOnly = found?.match === "mention";
const hit = mentionOnly ? null : found;
if (mentionOnly) {
  info(`No session for ${ticketKey} yet. It is only mentioned in "${found.title ?? found.session_id}" — not resuming that one.`);
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
  // changed there while it was parked, instead of waking up mid-thought. A
  // session saved under a plain name has no ticket and simply resumes.
  const key = ticketKey ?? hit.jira_key;
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

if (!ticketKey) {
  info(`No session matches "${query}" (and it is not a ticket key).`);
  info(`Try: sm -l "${query}" to see near matches.`);
  process.exit(1);
}

const { phrase, scoping } = await ticketPlan(ticketKey);
// A brand-new session gets the tab-naming rule too: the tab title is what the
// index, the dashboard and `sm` search on later, and an unnamed tab is lost work.
const kickoff = CONFIG.tabRule ? `${phrase}\n\n${CONFIG.tabRule}` : phrase;

if (mode === "new") {
  // The command cmux types into the tab must stay on ONE line — a newline would
  // submit it half-written — so a multi-line kickoff travels via a temp file.
  let claudeArg = `'${kickoff.replace(/'/g, `'\\''`)}'`;
  if (kickoff.includes("\n")) {
    const file = path.join(os.tmpdir(), `sm-kickoff-${Date.now()}.txt`);
    fs.writeFileSync(file, kickoff);
    claudeArg = `"$(cat '${file.replace(/'/g, `'\\''`)}')"`;
  }
  const r = openTab({
    workspaceName: scoping ? (CONFIG.scopingWorkspace || CONFIG.defaultWorkspace) : CONFIG.defaultWorkspace,
    cwd: process.env.HOME,
    command: `claude ${CONFIG.claudeFlags} ${claudeArg}`,
    title: ticketKey,
    focus: true,
  });
  console.log(`OPENED\t${r.workspace}\t${r.surface ?? ""}`);
} else {
  console.log(`PROMPT\t${kickoff}`);
}
