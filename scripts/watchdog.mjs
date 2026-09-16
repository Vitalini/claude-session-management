#!/usr/bin/env node
// Session watchdog: notices when a working session dies (usage limit, crash)
// or is about to hit the limit, briefs you on what it was doing, and resumes it
// ONLY on your say-so — from a Telegram button or the dashboard.
//
//   node watchdog.mjs            one pass (useful for testing)
//   node watchdog.mjs --daemon   run forever: scan loop + Telegram button loop
//   node watchdog.mjs --pair     connect the Telegram bot (see .env.local)
//
// Nothing here resumes on its own: hitting the limit means the whole account is
// throttled, so waking a fleet at reset would burn the fresh window instantly.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG, saveTabState, allTabStates, dropTabState,
  createIncident, getIncident, updateIncident, openIncidentFor, openWarning, pendingIncidents,
} from "./db.mjs";
import { cmux, wakeInTab, resumeSessionTab } from "./cmux-lib.mjs";
import { liveScan } from "./index-sessions.mjs";
import { analyzeSession } from "./analyze.mjs";
import * as tg from "./telegram.mjs";

const W = CONFIG.watchdog ?? {};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- screen reading & classification ----------

function readScreen(surface, workspaceRef) {
  try { return cmux("read-screen", "--surface", surface, "--workspace", workspaceRef); }
  catch { return null; }
}

// Claude Code's status line: "5h 63% ↻3h39m  7d 39% ↻4h19m"
export function parseUsage(screen) {
  const m = screen?.match(/5h\s+(\d+)%\s*↻\s*(?:(\d+)h)?(?:(\d+)m)?/);
  if (!m) return null;
  const mins = (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
  return { pct: Number(m[1]), resetsInMin: mins, resetAt: new Date(Date.now() + mins * 60000).toISOString() };
}

const LIMIT_RE = /(usage|rate)\s+limit|limit\s+reached|out of (usage|credits)|resets?\s+(at|in)\b|try again (later|at)|превышен лимит/i;
const CRASH_RE = /API Error|fatal error|panic:|Killed: 9|out of memory|ECONNRESET|unhandled (exception|rejection)/i;

// What happened in a tab whose claude is gone? The screen it left behind says.
export function classifyScreen(screen) {
  if (!screen) return { kind: "exit", reason: "screen unavailable" };
  const tail = screen.split("\n").slice(-60).join("\n");
  if (LIMIT_RE.test(tail)) return { kind: "limit", reason: "limit message on screen" };
  if (CRASH_RE.test(tail)) return { kind: "crash", reason: "error on screen" };
  return { kind: "exit", reason: "no error traces — looks like a normal exit" };
}

function resetTimeFromScreen(screen) {
  // "resets at 3:00pm" / "resets in 2h13m"
  const at = screen?.match(/resets?\s+at\s+([0-9]{1,2}:[0-9]{2}\s*(?:am|pm)?)/i)?.[1];
  if (at) return at;
  const inm = screen?.match(/resets?\s+in\s+((?:\d+h)?(?:\s*\d+m)?)/i)?.[1];
  return inm ? `in ${inm.trim()}` : null;
}

// ---------- scanning ----------

function scanTabs() {
  return liveScan()?.tabs ?? [];
}

const KIND_LABEL = { limit: "🚧 Hit the usage limit", crash: "💥 Crashed", exit: "⏹ Exited", warning: "⚠️ Nearing the usage limit" };

async function notify(incidentId) {
  const inc = getIncident(incidentId);
  if (!inc || !tg.isConfigured()) return;
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const head = `<b>${KIND_LABEL[inc.kind] ?? inc.kind}</b>\n<b>${esc(inc.title || inc.session_id)}</b>`;
  const where = `${esc(inc.workspace ?? "-")} · <code>${esc((inc.cwd ?? "").replace(/^\/Users\/[^/]+/, "~"))}</code>`;
  const when = inc.reset_at ? `\nWindow frees up: ${esc(inc.reset_at)}` : "";
  const text = `${head}\n${where}${when}\n\n${esc(inc.analysis ?? "")}`;

  const buttons = inc.kind === "warning"
    ? [{ text: "Got it", callback_data: `dis:${inc.id}` }]
    : [
        { text: "▶️ Resume", callback_data: `res:${inc.id}` },
        { text: "🕐 Later", callback_data: `snz:${inc.id}` },
        { text: "✖️ Skip", callback_data: `dis:${inc.id}` },
      ];
  try {
    const messageId = await tg.sendAlert(text, buttons);
    updateIncident(inc.id, { tg_message_id: messageId });
  } catch (e) { log("telegram:", e.message); }
}

function tick() {
  const tabs = scanTabs();
  const seen = new Set();
  const known = new Map(allTabStates().map((r) => [r.surface, r]));
  const now = new Date().toISOString();
  const liveWithUsage = []; // the 5h window is per ACCOUNT, so warn once for all

  for (const t of tabs) {
    seen.add(t.surface);
    const prev = known.get(t.surface);
    const live = Boolean(t.session_id);
    const state = {
      surface: t.surface, workspace_ref: t.workspaceRef, workspace: t.workspace,
      session_id: t.session_id ?? t.db_session_id ?? prev?.session_id ?? null,
      title: t.title, cwd: t.cwd ?? t.db_cwd ?? prev?.cwd ?? null,
      was_live: live ? 1 : 0, last_live_at: live ? now : prev?.last_live_at ?? null,
      usage_pct: prev?.usage_pct ?? null, usage_reset: prev?.usage_reset ?? null,
      warned_at: prev?.warned_at ?? null, updated_at: now,
    };

    if (live) {
      const screen = readScreen(t.surface, t.workspaceRef);
      const usage = parseUsage(screen);
      if (usage) {
        state.usage_pct = usage.pct;
        state.usage_reset = usage.resetAt;
        liveWithUsage.push({ tab: t, usage });
      }
    } else if (prev?.was_live) {
      // Was running on the previous tick, isn't now: something ended it.
      const screen = readScreen(t.surface, t.workspaceRef);
      const { kind, reason } = classifyScreen(screen);
      const sessionId = prev.session_id ?? t.db_session_id;
      log(`down: ${t.title} → ${kind} (${reason})`);
      if ((W.notifyKinds ?? ["limit", "crash"]).includes(kind) && sessionId && !openIncidentFor(sessionId, kind)) {
        const a = analyzeSession(sessionId, prev.cwd ?? t.db_cwd);
        const id = createIncident({
          session_id: sessionId, surface: t.surface, workspace_ref: t.workspaceRef,
          workspace: t.workspace, title: t.title, cwd: prev.cwd ?? t.db_cwd, kind,
          detected_at: now, reset_at: resetTimeFromScreen(screen),
          screen: screen?.split("\n").slice(-25).join("\n") ?? null,
          analysis: a.text, status: "pending",
        });
        notify(id);
      }
    }
    saveTabState(state);
  }

  // Tabs that vanished entirely were closed deliberately (or hibernated) — forget them.
  for (const surface of known.keys()) if (!seen.has(surface)) dropTabState(surface);

  // One warning per usage window, not per session: the 5h quota is shared by the
  // whole account, so N alerts saying the same thing is noise, not information.
  if (liveWithUsage.length) {
    const worst = liveWithUsage.reduce((a, b) => (b.usage.pct > a.usage.pct ? b : a));
    if (worst.usage.pct >= (W.warnAtPercent ?? 85) && !openWarning()) {
      const resetIn = `in ${Math.floor(worst.usage.resetsInMin / 60)}h ${worst.usage.resetsInMin % 60}m`;
      const names = liveWithUsage.map((x) => `· ${x.tab.title} (${x.tab.workspace})`).join("\n");
      const id = createIncident({
        session_id: worst.tab.session_id, surface: worst.tab.surface, workspace_ref: worst.tab.workspaceRef,
        workspace: worst.tab.workspace, title: `${liveWithUsage.length} live sessions`, cwd: worst.tab.cwd,
        kind: "warning", detected_at: now, reset_at: resetIn, screen: null, status: "pending",
        analysis: `The shared 5h window is ${worst.usage.pct}% used — there is one window for the whole account.\n` +
          `Running right now:\n${names}\n\nWrap up anything important: once the limit hits, these sessions get cut off.`,
      });
      log(`warning: account at ${worst.usage.pct}%, ${liveWithUsage.length} live sessions`);
      notify(id);
    }
  }
}

// ---------- acting on a decision ----------

export async function resumeIncident(id, via = "dashboard") {
  const inc = getIncident(id);
  if (!inc) throw new Error(`incident ${id} not found`);
  if (!inc.session_id) throw new Error("incident has no session id");

  let where;
  const stillThere = (() => {
    try { return cmux("tree", "--workspace", inc.workspace_ref).includes(`surface ${inc.surface} `); }
    catch { return false; }
  })();

  if (stillThere && inc.cwd) {
    wakeInTab({ surface: inc.surface, workspace: inc.workspace_ref, sessionId: inc.session_id, cwd: inc.cwd });
    where = { surface: inc.surface, workspace: inc.workspace_ref };
  } else {
    const r = resumeSessionTab(inc.session_id, { focus: false });
    where = { surface: r.surface, workspace: r.workspace };
  }
  updateIncident(id, { status: "resumed", decided_at: new Date().toISOString(), decided_via: via });

  // Nudge it back to work once claude is actually up. Type, verify the text
  // landed, then Enter — sending blind into a booting TUI drops the keystroke.
  if (W.nudge && where.surface) {
    setTimeout(async () => {
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const screen = readScreen(where.surface, where.workspace) ?? "";
        if (!/❯|>\s*$/m.test(screen)) continue;
        try {
          cmux("send", "--surface", where.surface, "--workspace", where.workspace, W.nudge);
          await new Promise((r) => setTimeout(r, 1200));
          const after = readScreen(where.surface, where.workspace) ?? "";
          if (!after.includes(W.nudge.slice(0, 20))) continue;
          cmux("send-key", "--surface", where.surface, "--workspace", where.workspace, "enter");
          log(`nudged incident ${id}`);
        } catch (e) { log("nudge failed:", e.message); }
        return;
      }
      log(`nudge: prompt never appeared for incident ${id}`);
    }, 1000);
  }
  return where;
}

// ---------- telegram button loop ----------

async function buttonLoop() {
  let offset = 0;
  for (;;) {
    try {
      const [updates, next] = await tg.pollUpdates(offset);
      offset = next;
      for (const u of updates) {
        // "/here" (or /start) in any chat moves alerts to that chat — handy for
        // switching from a group to a DM without touching .env.local.
        const text = u.message?.text ?? "";
        if (/^\/(here|start)\b/.test(text) && u.message?.chat?.id) {
          tg.setChatId(u.message.chat.id);
          log(`alerts now go to chat ${u.message.chat.id}`);
          await tg.sendAlert("✅ Alerts will come to this chat from now on.");
          continue;
        }
        const cb = u.callback_query;
        if (!cb) continue;
        const [action, idStr] = String(cb.data ?? "").split(":");
        const id = Number(idStr);
        const inc = getIncident(id);
        if (!inc) { await tg.answerCallback(cb.id, "Incident not found"); continue; }

        if (action === "res") {
          try {
            await resumeIncident(id, "telegram");
            await tg.answerCallback(cb.id, "Resuming…");
            await tg.editAlert(inc.tg_message_id, `▶️ Resumed: ${inc.title ?? inc.session_id}\n${inc.analysis ?? ""}`);
          } catch (e) {
            await tg.answerCallback(cb.id, `Failed: ${e.message}`.slice(0, 190));
          }
        } else if (action === "snz") {
          const until = new Date(Date.now() + 3600_000).toISOString();
          updateIncident(id, { status: "snoozed", snooze_until: until });
          await tg.answerCallback(cb.id, "Will remind you in an hour");
          await tg.editAlert(inc.tg_message_id, `🕐 Snoozed for an hour: ${inc.title ?? inc.session_id}`);
        } else if (action === "dis") {
          updateIncident(id, { status: "dismissed", decided_at: new Date().toISOString(), decided_via: "telegram" });
          await tg.answerCallback(cb.id, "Ok, leaving it alone");
          await tg.editAlert(inc.tg_message_id, `✖️ Skipped: ${inc.title ?? inc.session_id}`);
        }
      }
    } catch (e) {
      log("button loop:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Snoozed incidents come back when their hour is up.
async function remindSnoozed() {
  for (const inc of pendingIncidents()) {
    if (inc.status === "snoozed") {
      updateIncident(inc.id, { status: "pending", snooze_until: null });
      await notify(inc.id);
    }
  }
}

// ---------- main (only when run directly — the API imports resumeIncident) ----------

const runDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (runDirectly) {
  const args = process.argv.slice(2);
  tg.loadEnv();

  const flagValue = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };

  if (args.includes("--pair")) {
    await tg.pair();
  } else if (flagValue("--resume")) {
    // Called by the dashboard API (a subprocess keeps Next's bundler out of this file).
    const where = await resumeIncident(Number(flagValue("--resume")), flagValue("--via") ?? "dashboard");
    console.log(JSON.stringify(where));
    // Give the nudge timer a chance to land before exiting.
    await new Promise((r) => setTimeout(r, W.nudge ? 75000 : 0));
  } else if (W.enabled === false) {
    log("watchdog disabled in config.json");
  } else if (args.includes("--daemon")) {
    log(`daemon: every ${W.intervalSec ?? 60}s, warn at ${W.warnAtPercent ?? 85}%` +
        `, telegram ${tg.isConfigured() ? "connected" : "not configured (dashboard only)"}`);
    if (tg.isConfigured()) buttonLoop();
    for (;;) {
      try { tick(); await remindSnoozed(); } catch (e) { log("tick failed:", e.message); }
      await new Promise((r) => setTimeout(r, (W.intervalSec ?? 60) * 1000));
    }
  } else {
    tick();
    log("single pass done");
  }
}
