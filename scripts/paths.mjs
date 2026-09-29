// Where should a session start?
//
// A session row remembers the folder it ran in. Folders move: rename a
// directory tree and hundreds of indexed sessions point at a path that is no
// longer there, and every resume dies on `cd`. That is recoverable, because
// `claude --resume <id>` finds a transcript from ANY working directory — the
// lookup is not scoped to the cwd. A missing folder therefore only means
// "start somewhere sensible and say so", never "give up".
//
// resolveCwd() is the single place that answers it, so the CLI, the dashboard
// and the watchdog all land in the same directory and print the same warning.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "./db.mjs";

export function dirExists(p) {
  if (!p) return false;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// `~/work` in a config value means the same thing it means in a shell.
export function expandHome(p) {
  const s = String(p ?? "");
  if (s === "~") return os.homedir();
  return s.startsWith("~/") ? path.join(os.homedir(), s.slice(2)) : s;
}

// config.json → pathAliases: { "/old/prefix": "/new/prefix" }.
export function configuredAliases() {
  return CONFIG.pathAliases ?? {};
}

// Rewrite `dir` through the alias whose OLD prefix matches it, longest prefix
// first — so a specific "/old/claude/scoping" wins over a broad "/old". Returns
// null when no alias covers the path. Existence is the caller's business: the
// remap CLI and resolveCwd both want to know "is there a mapping at all?"
// separately from "does the mapped folder exist?".
export function applyAliases(dir, aliases = configuredAliases()) {
  const target = expandHome(dir);
  if (!target) return null;
  const entries = Object.entries(aliases ?? {})
    .map(([from, to]) => [expandHome(from).replace(/\/+$/, ""), expandHome(to).replace(/\/+$/, "")])
    .filter(([from, to]) => from && to)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of entries) {
    if (target === from) return to;
    if (target.startsWith(`${from}/`)) return path.join(to, target.slice(from.length + 1));
  }
  return null;
}

const goneNote = (original, dir, why) =>
  `⚠ Folder ${original} is gone — starting in ${dir}${why ? ` ${why}` : ""}; ` +
  `paths inside the session history still point at the old location.`;

// { dir, note }. `dir` is ALWAYS a directory that exists; `note` is a line to
// show the user when it is not the folder they saved, and null when it is.
//
// Order: the folder itself → a configured alias → the nearest existing
// ancestor → the home directory. The ancestor walk stops short of "/": landing
// a session in the filesystem root is worse than landing it at home.
export function resolveCwd(cwd, { aliases } = {}) {
  const home = os.homedir();
  const original = expandHome(String(cwd ?? "").trim());

  if (!original) return { dir: home, note: `⚠ No folder recorded for this session — starting in ${home}.` };
  if (dirExists(original)) return { dir: original, note: null };

  const mapped = applyAliases(original, aliases ?? configuredAliases());
  if (mapped && dirExists(mapped)) return { dir: mapped, note: goneNote(original, mapped, "(pathAliases remap)") };

  let p = path.dirname(path.resolve(original));
  while (p !== path.dirname(p)) {
    if (dirExists(p)) return { dir: p, note: goneNote(original, p, "(nearest existing folder)") };
    p = path.dirname(p);
  }
  return { dir: home, note: goneNote(original, home) };
}
