// One source of truth for ticket keys and ticket links.
//
// Ticket tracking is optional and tracker-agnostic: `config.json → tickets`
// says whether it is on, where the tracker lives, and which project key
// prefixes count as a ticket. Nothing else in the codebase may hard-code a key
// shape or build a ticket URL by hand — a user on another tracker, or with no
// tracker at all, must still get working sessions.
//
// Note on the cycle: db.mjs owns CONFIG and imports the matchers from here.
// Both modules only touch each other inside functions, never at module top
// level, so the ES module cycle resolves cleanly whichever side is entered first.
import { CONFIG } from "./db.mjs";

// Fallback when no project keys are configured: anything that LOOKS like a key.
// Three digits minimum — with no configured prefix to lean on, `UTF-8`, `GPT-4`,
// `COVID-19` and `HTTP-2` are ordinary words, and indexing them as tickets
// poisons the index with keys no tracker will ever resolve.
const GENERIC_KEY = "[A-Z][A-Z0-9]{1,9}-\\d{3,6}";
// A pattern that can never match, for when ticket tracking is off. It still has
// to be a valid sub-expression: callers embed it in larger regexes.
const NEVER = "(?!)";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function cfg() {
  return CONFIG.tickets ?? {};
}

function projectKeys() {
  const keys = cfg().projectKeys;
  return (Array.isArray(keys) ? keys : [])
    .map((k) => String(k ?? "").trim().toUpperCase())
    .filter(Boolean);
}

function baseUrl() {
  return String(cfg().baseUrl ?? "").trim().replace(/\/+$/, "");
}

/** Ticket features (links, tracker API calls, ticket UI) are configured on. */
export function ticketsEnabled() {
  return cfg().enabled !== false && Boolean(baseUrl());
}

/** Tracker root without a trailing slash, or "" when ticket tracking is off. */
export function ticketBaseUrl() {
  return ticketsEnabled() ? baseUrl() : "";
}

// The key shape itself, regardless of whether tracking is on. Configured project
// keys restrict it and license the loose `\d{1,6}` tail: an explicit prefix is
// signal enough that KEY-42 is a ticket.
function keyShape() {
  // Longest prefix first: PS before PSAI would otherwise decide the match for
  // "PSAI-75" on a backtrack the anchored callers cannot afford.
  const keys = projectKeys().sort((a, b) => b.length - a.length);
  return keys.length ? `(?:${keys.map(escape).join("|")})-\\d{1,6}` : GENERIC_KEY;
}

/**
 * The key pattern WITHOUT word boundaries, for callers that embed it in a
 * larger expression (e.g. the "[KEY][Client] - title" tab-title convention).
 * With ticket tracking off it matches nothing, so the index stops collecting
 * keys the UI would never show.
 */
export function ticketKeyPattern() {
  return ticketsEnabled() ? keyShape() : NEVER;
}

/** Ticket-key matcher, e.g. ticketKeyRe("g") to sweep a transcript. */
export function ticketKeyRe(flags = "") {
  return new RegExp(`\\b${ticketKeyPattern()}\\b`, flags);
}

/** First ticket key inside a longer string, or null. */
export function parseTicketKey(text) {
  return String(text ?? "").match(ticketKeyRe())?.[0] ?? null;
}

/**
 * The key when the WHOLE trimmed string is one, EVEN with tracking off — the CLI
 * still greets a bare `PROJ-123` with a kickoff phrase, it just has no link.
 * Callers that need the ticket-tracking gate use ticketKeyExact().
 */
export function bareKeyExact(text) {
  const t = String(text ?? "").trim().toUpperCase();
  return new RegExp(`^(?:${keyShape()})$`).test(t) ? t : null;
}

/** The key only when the WHOLE trimmed string is one — a bare key means THAT ticket. */
export function ticketKeyExact(text) {
  return ticketsEnabled() ? bareKeyExact(text) : null;
}

/** Link to a ticket, or null when ticket tracking is off (callers show the bare key). */
export function ticketUrl(key) {
  if (!key || !ticketsEnabled()) return null;
  const path = String(cfg().browsePath ?? "/browse/");
  const normalized = `/${path.replace(/^\/+|\/+$/g, "")}/`;
  return `${baseUrl()}${normalized === "//" ? "/" : normalized}${key}`;
}

// A ticket link is a URL, not any string with a /browse/ segment in it: a local
// path like /Users/me/browse/AB-12/file.txt is a file, not a ticket.
const URL_LIKE = /(?:https?:\/\/|(?:^|[\s(<"'])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/)[^\s)<>"']*/i;

/** The key inside a pasted tracker URL — a link is just a key with decoration. */
export function keyFromUrl(text) {
  if (!ticketsEnabled()) return null;
  const url = String(text ?? "").match(URL_LIKE)?.[0];
  if (!url) return null;
  const pattern = ticketKeyPattern();
  const browse = String(cfg().browsePath ?? "/browse/").replace(/^\/+|\/+$/g, "") || "browse";
  const prefixes = [...new Set([escape(browse), "browse", "issues?", "tickets?"])];
  const re = new RegExp(`(?:/(?:${prefixes.join("|")})/|[?&#][^=&#]*(?:issue|key|id)=)(${pattern})`, "i");
  return url.match(re)?.[1]?.toUpperCase() ?? null;
}
