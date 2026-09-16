// Read a session's transcript tail and describe what it was doing — the
// "should I bring this back?" briefing shown before any resume.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CONFIG } from "./db.mjs";

const PROJECTS_DIR = CONFIG.claudeProjectsDir.replace(/^~/, os.homedir());

function transcriptPath(sessionId, cwd) {
  if (cwd) {
    const p = path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  for (const dir of fs.readdirSync(PROJECTS_DIR)) {
    const p = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Transcripts run to hundreds of MB; only the tail matters here.
function tailLines(file, maxBytes = 900_000) {
  const { size } = fs.statSync(file);
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const text = buf.toString("utf8");
  return text.slice(text.indexOf("\n") + 1).split("\n").filter(Boolean);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
}

const squish = (s, n) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function analyzeSession(sessionId, cwd) {
  const file = transcriptPath(sessionId, cwd);
  if (!file) return { ok: false, text: "No transcript found — you can still resume, but blind." };

  const { mtimeMs, size } = fs.statSync(file);
  let lines;
  try { lines = tailLines(file); } catch (e) { return { ok: false, text: `Could not read the transcript: ${e.message}` }; }

  let lastUser = null, lastAssistant = null, todos = null, gitBranch = null, model = null;
  let userCount = 0, toolCalls = 0, lastTs = null, firstTsInTail = null;
  const toolNames = new Map();

  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp) { lastTs = o.timestamp; firstTsInTail ??= o.timestamp; }
    gitBranch = o.gitBranch ?? gitBranch;
    if (o.type === "user") {
      const t = textOf(o.message?.content);
      // Skip tool results and system-injected blocks — keep what the human typed.
      if (t && !t.startsWith("<") && !t.startsWith("Caveat:")) { lastUser = t; userCount++; }
    } else if (o.type === "assistant") {
      model = o.message?.model ?? model;
      const t = textOf(o.message?.content);
      if (t.trim()) lastAssistant = t;
      for (const c of o.message?.content ?? []) {
        if (c?.type === "tool_use") {
          toolCalls++;
          toolNames.set(c.name, (toolNames.get(c.name) ?? 0) + 1);
          if (c.name === "TodoWrite" && Array.isArray(c.input?.todos)) todos = c.input.todos;
        }
      }
    }
  }

  const pending = (todos ?? []).filter((t) => t.status !== "completed");
  const idleMin = Math.round((Date.now() - mtimeMs) / 60000);
  const topTools = [...toolNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([n, c]) => `${n}×${c}`).join(", ");

  const parts = [];
  parts.push(`Last activity: ${idleMin < 60 ? `${idleMin} min ago` : `${Math.round(idleMin / 60)} h ago`}` +
    `${gitBranch ? ` · branch ${gitBranch}` : ""}${model ? ` · ${model}` : ""}`);
  if (lastUser) parts.push(`You asked: "${squish(lastUser, 220)}"`);
  if (lastAssistant) parts.push(`Cut off at: "${squish(lastAssistant, 260)}"`);
  if (pending.length) {
    parts.push(`Open TODOs (${pending.length}): ` +
      pending.slice(0, 4).map((t) => squish(t.content ?? t.activeForm ?? "", 60)).join("; "));
  }
  parts.push(`Size: ${(size / 1e6).toFixed(1)} MB transcript, ${toolCalls} tool calls${topTools ? ` (${topTools})` : ""}`);

  return {
    ok: true,
    text: parts.join("\n"),
    lastUser: squish(lastUser, 400),
    lastAssistant: squish(lastAssistant, 400),
    pendingTodos: pending.length,
    idleMin,
    lastTs,
  };
}
