"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Session = {
  session_id: string;
  cwd: string | null;
  title: string | null;
  jira_key: string | null;
  client: string | null;
  workspace: string | null;
  status: string;
  summary: string | null;
  first_prompt: string | null;
  updated_at: string | null;
};

type Tab = {
  session_id: string | null;
  surface: string;
  workspaceRef: string;
  workspace: string;
  title: string;
  cwd: string | null;
  db_session_id?: string | null;
  db_cwd?: string | null;
};

type Workspace = { ref: string; name: string };

const ALL = "__all__";

function shortDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function shortPath(p: string | null) {
  return p ? p.replace(/^\/Users\/[^/]+/, "~") : "";
}

export default function Home() {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<string>(ALL);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [counts, setCounts] = useState<{ status: string; n: number }[]>([]);
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [ticketDone, setTicketDone] = useState<Record<string, string>>({}); // ticket key -> status name (done-category only)
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  // Ticket tracking is optional — the tracker link prefix and the key pattern
  // come from config.json. With tracking off there is no pattern, so no key is
  // ever parsed out of a tab title, and stored keys stay plain text instead of
  // turning into dead links.
  const [ticketBase, setTicketBase] = useState("");
  const [keyPattern, setKeyPattern] = useState<string | null>(null);
  // Built once here and reused everywhere a tab title is scanned for a key.
  const ticketRe = useMemo(
    () => (keyPattern ? new RegExp(`\\b${keyPattern}\\b`) : null),
    [keyPattern]
  );
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusKeysRef = useRef("");
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search from anywhere, Esc clears it — this page is a search box first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typingElsewhere = document.activeElement === searchRef.current;
      if (e.key === "/" && !typingElsewhere) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === "Escape" && typingElsewhere) { setQ(""); loadSessionsRef.current?.(""); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const loadSessionsRef = useRef<((v: string) => void) | null>(null);

  // --- theme ---
  useEffect(() => {
    const saved = (localStorage.getItem("sm-theme") as "light" | "dark") || "light";
    setTheme(saved);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("sm-theme", theme);
  }, [theme]);

  // --- data loading ---
  const loadSessions = useCallback((query: string, ws: string) => {
    const params = new URLSearchParams({ q: query, limit: "200" });
    if (ws !== ALL) params.set("workspace", ws);
    fetch(`/api/sessions?${params}`)
      .then((r) => r.json())
      .then((d) => { setSessions(d.sessions ?? []); setCounts(d.counts ?? []); })
      .catch(() => {});
  }, []);

  const loadActive = useCallback(() => {
    fetch("/api/active").then((r) => r.json()).then((d) => {
      setTabs(d.tabs ?? []);
      if (d.workspaces) setWorkspaces(d.workspaces);
    }).catch(() => setTabs([]));
  }, []);

  useEffect(() => { loadSessions("", ALL); loadActive(); }, [loadSessions, loadActive]);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        const path = d.ticketBrowsePath || "/browse/";
        setTicketBase(d.ticketsEnabled && d.ticketBaseUrl ? `${d.ticketBaseUrl}${path}` : "");
        setKeyPattern(d.ticketsEnabled ? (d.ticketKeyPattern ?? null) : null);
      })
      .catch(() => {});
  }, []);

  // Live mirror of cmux: poll active tabs so closes/opens in cmux show up here.
  useEffect(() => {
    const t = setInterval(loadActive, 8000);
    return () => clearInterval(t);
  }, [loadActive]);

  // Ticket statuses for active claude tabs → suggest hibernation when done.
  // Skipped entirely when ticket tracking is off: no pattern, no keys, no call.
  useEffect(() => {
    const keys = [...new Set((tabs ?? []).map((t) => t.session_id && parseKey(t.title, ticketRe)).filter(Boolean))] as string[];
    const sig = keys.sort().join(",");
    if (!sig || sig === statusKeysRef.current) return;
    statusKeysRef.current = sig;
    fetch(`/api/jira/statuses?keys=${sig}`)
      .then((r) => r.json())
      .then((d) => {
        const done: Record<string, string> = {};
        for (const [k, v] of Object.entries(d.statuses ?? {})) {
          const s = v as { status: string; category: string };
          if (s.category === "done") done[k] = s.status;
        }
        setTicketDone(done);
      })
      .catch(() => {});
  }, [tabs, ticketRe]);

  loadSessionsRef.current = (v: string) => loadSessions(v, group);

  const onSearch = (v: string) => {
    setQ(v);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => loadSessions(v, group), 250);
  };

  const selectGroup = (g: string) => {
    setGroup(g);
    loadSessions(q, g);
  };

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 4000); };

  // --- actions ---
  const post = async (url: string, body: unknown) => {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) flash(d.error ?? `Error ${r.status}`);
    return d;
  };

  const resume = async (sessionId: string) => {
    setBusy(sessionId);
    await post("/api/resume", { session_id: sessionId });
    setBusy(null);
    setTimeout(() => { loadActive(); loadSessions(q, group); }, 1500);
  };

  const focus = (tab: Tab) => post("/api/resume", { workspace: tab.workspaceRef, surface: tab.surface });

  const hibernate = async (tab: Tab | null) => {
    const id = tab?.surface ?? "current";
    setBusy(id);
    const d = await post("/api/hibernate", tab
      ? { surface: tab.surface, workspace: tab.workspaceRef, session_id: tab.session_id, cwd: tab.cwd }
      : { current: true });
    setBusy(null);
    if (d.ok) flash(`💤 Hibernated: ${d.title ?? d.session_id}`);
    setTimeout(() => { loadActive(); loadSessions(q, group); }, 800);
  };

  const addTab = async (wsName: string) => {
    const d = await post("/api/tab", { workspace: wsName });
    if (d.ok) flash(`New tab opened in ${wsName}`);
    setTimeout(loadActive, 1500);
  };

  const addWorkspace = async () => {
    const name = window.prompt("New workspace name:");
    if (!name?.trim()) return;
    const d = await post("/api/workspace", { name: name.trim() });
    if (d.ok) flash(`Workspace "${name.trim()}" created`);
    setTimeout(loadActive, 1200);
  };

  const renameWorkspace = async (wsName: string) => {
    const ref = workspaces.find((w) => w.name === wsName)?.ref;
    if (!ref) return;
    const name = window.prompt("Rename workspace:", wsName);
    if (!name?.trim() || name.trim() === wsName) return;
    const d = await post("/api/workspace", { ref, rename: name.trim() });
    if (d.ok) { flash(`Renamed to "${name.trim()}"`); setGroup(name.trim()); }
    setTimeout(loadActive, 800);
  };

  const wake = async (tab: Tab) => {
    if (!tab.db_session_id || !tab.db_cwd) return;
    setBusy(tab.surface);
    const d = await post("/api/tab", {
      surface: tab.surface, workspaceRef: tab.workspaceRef,
      wake_session_id: tab.db_session_id, cwd: tab.db_cwd,
    });
    setBusy(null);
    if (d.ok) flash("▶ Waking session in that tab…");
    setTimeout(loadActive, 4000);
  };

  const renameTab = async (tab: Tab) => {
    const name = window.prompt("Rename tab:", tab.title);
    if (!name?.trim() || name.trim() === tab.title) return;
    const d = await post("/api/tab", { surface: tab.surface, workspaceRef: tab.workspaceRef, rename: name.trim() });
    if (d.ok) flash("Tab renamed");
    setTimeout(loadActive, 800);
  };

  const sync = async () => {
    setSyncing(true);
    await fetch("/api/sync", { method: "POST" }).catch(() => {});
    setSyncing(false);
    loadSessions(q, group); loadActive();
  };

  // --- derived ---
  const activeIds = useMemo(() => new Set((tabs ?? []).map((t) => t.session_id).filter(Boolean)), [tabs]);
  const tabsByWs = useMemo(() => {
    const m = new Map<string, Tab[]>();
    for (const t of tabs ?? []) {
      if (!m.has(t.workspace)) m.set(t.workspace, []);
      m.get(t.workspace)!.push(t);
    }
    return m;
  }, [tabs]);

  // Sidebar: cmux workspaces in cmux order, then DB-only workspaces.
  const sidebarGroups = useMemo(() => {
    const live = workspaces.map((w) => w.name);
    const dbOnly = [...new Set(sessions.map((s) => s.workspace).filter(Boolean) as string[])]
      .filter((w) => !live.includes(w));
    return [...live, ...dbOnly];
  }, [workspaces, sessions]);

  const sleepCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) {
      if (s.status === "saved" && s.workspace && !activeIds.has(s.session_id)) {
        m.set(s.workspace, (m.get(s.workspace) ?? 0) + 1);
      }
    }
    return m;
  }, [sessions, activeIds]);

  const visibleTabs = useMemo(() => {
    let list = tabs ?? [];
    if (group !== ALL) list = list.filter((t) => t.workspace === group);
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter((t) =>
        t.title.toLowerCase().includes(needle) || (t.cwd ?? "").toLowerCase().includes(needle));
    }
    return list;
  }, [tabs, group, q]);

  // DB rows marked 'active' but with no live tab (e.g. right after a reboot,
  // before sync demotes them) are effectively cold — show them as sleeping
  // rather than hiding them. Rows WITH a live tab stay in the Active section only.
  const coldSessions = sessions
    .filter((s) => !activeIds.has(s.session_id))
    .map((s) => (s.status === "active" ? { ...s, status: "saved" } : s));
  const sleeping = coldSessions.filter((s) => s.status === "saved");
  const historical = coldSessions.filter((s) => s.status !== "saved");
  const countStr = counts.map((c) => `${c.status}: ${c.n}`).join(" · ");
  // A tab's title says where it is; the opening prompt says what it is.
  const firstPromptById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessions) if (s.first_prompt) m.set(s.session_id, s.first_prompt);
    return m;
  }, [sessions]);
  const liveCount = (tabs ?? []).filter((t) => t.session_id).length;
  const wakeableCount = (tabs ?? []).filter((t) => !t.session_id && t.db_session_id).length;
  // "Idle" = nothing asked for yet: search owns the screen until it is.
  const idle = !q.trim() && group === ALL;
  const doneSuggestions = visibleTabs.filter((t) => t.session_id && ticketDone[parseKey(t.title, ticketRe) ?? ""]);

  return (
    <div className="shell">
      <aside>
        <div className="brand">Session <span>Mgmt</span></div>
        <button className={`nav ${group === ALL ? "sel" : ""}`} onClick={() => selectGroup(ALL)}>
          <span className="nav-name">All sessions</span>
          <span className="nav-counts">{tabs?.filter((t) => t.session_id).length ?? "…"}</span>
        </button>
        <div className="nav-sep">
          cmux workspaces
          <button className="mini" onClick={addWorkspace} title="New workspace">+</button>
        </div>
        {sidebarGroups.map((g) => {
          const live = (tabsByWs.get(g) ?? []).filter((t) => t.session_id).length;
          const sleep = sleepCounts.get(g) ?? 0;
          return (
            <button key={g} className={`nav ${group === g ? "sel" : ""}`} onClick={() => selectGroup(g)}>
              <span className="nav-name">{g}</span>
              <span className="nav-counts">
                {live > 0 && <em className="live-n">{live}</em>}
                {sleep > 0 && <em className="sleep-n">{sleep}💤</em>}
              </span>
            </button>
          );
        })}
      </aside>

      <main className={idle ? "idle" : ""}>
        <div className="tools">
          <span className="counts">{countStr}</span>
          <button onClick={() => hibernate(null)} disabled={busy === "current"} title="Save and close the tab currently focused in cmux">
            💤 Hibernate current
          </button>
          <button onClick={sync} disabled={syncing}>{syncing ? <span className="spin">◐</span> : "⟳"} Sync</button>
          <button className="ghost" onClick={() => setTheme(theme === "light" ? "dark" : "light")} title="Theme">
            {theme === "light" ? "🌙" : "☀️"}
          </button>
        </div>

        <div className={idle ? "hero" : "searchbar"}>
          <input
            ref={searchRef}
            className="search"
            placeholder={group === ALL ? "Search sessions: PROJ-123, name, folder, text…" : `Search in ${group}…`}
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            autoFocus
          />
          {idle && (
            <div className="hero-hint">
              <span><b>{liveCount}</b> live</span>
              <span><b>{wakeableCount}</b> wakeable</span>
              <span><b>{sleeping.length}</b> sleeping</span>
              <span className="dim">press <kbd>/</kbd> to search from anywhere</span>
            </div>
          )}
        </div>

        {toast && <div className="toast">{toast}</div>}


        {doneSuggestions.length > 0 && (
          <div className="suggest">
            Closed tickets with open sessions:{" "}
            {doneSuggestions.map((t) => (
              <button key={t.surface} className="suggest-btn" onClick={() => hibernate(t)} disabled={busy === t.surface}>
                💤 {parseKey(t.title, ticketRe)}
              </button>
            ))}
          </div>
        )}


        <h2>
          Active {group !== ALL ? `— ${group} ` : ""}<span className="n">{visibleTabs.length}</span>
          {group !== ALL && <button className="add" onClick={() => addTab(group)}>+ tab</button>}
          {group !== ALL && workspaces.some((w) => w.name === group) && (
            <button className="add" onClick={() => renameWorkspace(group)} title="Rename workspace">✎</button>
          )}
        </h2>
        {!tabs && <div className="empty">Loading cmux…</div>}
        {tabs && visibleTabs.length === 0 && <div className="empty">No open tabs{q ? " matching the query" : ""}.</div>}
        <div className="list">
          {visibleTabs.map((t) => {
            const key = parseKey(t.title, ticketRe);
            const done = t.session_id && key ? ticketDone[key] : undefined;
            const prompt = firstPromptById.get(t.session_id ?? t.db_session_id ?? "");
            return (
              <div className={`item ${done ? "warn" : ""}`} key={t.surface}>
                <span className={`badge ${t.session_id ? "active" : t.db_session_id ? "saved" : "plain"}`}>
                  {t.session_id ? "live" : t.db_session_id ? "idle" : "shell"}
                </span>
                {group === ALL && <span className="ws-tag">{t.workspace}</span>}
                <span className="main">
                  <span className="title">{t.title}</span>
                  {prompt && <span className="prompt">{prompt}</span>}
                </span>
                {done && <span className="badge due">Ticket: {done} — hibernate?</span>}
                <span className="meta">{shortPath(t.cwd ?? t.db_cwd ?? null)}</span>
                <button className="ghost mini-act" onClick={() => renameTab(t)} title="Rename tab">✎</button>
                {t.session_id && (
                  <button onClick={() => hibernate(t)} disabled={busy === t.surface} title="Save and close this tab">
                    {busy === t.surface ? "…" : "💤"}
                  </button>
                )}
                {!t.session_id && t.db_session_id && t.db_cwd && (
                  <button className="primary" onClick={() => wake(t)} disabled={busy === t.surface}
                    title="claude exited in this tab — resume its session right here">
                    {busy === t.surface ? "…" : "▶ Wake"}
                  </button>
                )}
                <button onClick={() => focus(t)}>Go to →</button>
              </div>
            );
          })}
        </div>

        <h2>Sleeping <span className="n">{sleeping.length}</span></h2>
        <div className="list">
          {!tabs && <div className="empty">Loading…</div>}
          {tabs && sleeping.length === 0 && <div className="empty">No sleeping sessions{group !== ALL ? ` in ${group}` : ""}.</div>}
          {tabs && sleeping.map((s) => <SessionItem key={s.session_id} s={s} busy={busy} resume={resume} showWs={group === ALL} ticketBase={ticketBase} />)}
        </div>

        <h2>History <span className="n">{historical.length}</span></h2>
        <div className="list">
          {!tabs && <div className="empty">Loading…</div>}
          {tabs && historical.length === 0 && <div className="empty">Empty.</div>}
          {tabs && historical.slice(0, 60).map((s) => <SessionItem key={s.session_id} s={s} busy={busy} resume={resume} showWs={group === ALL} ticketBase={ticketBase} />)}
        </div>
      </main>
    </div>
  );
}

// The key shape is configured (tickets.projectKeys), not assumed. No pattern
// means ticket tracking is off — then nothing in a tab title is a ticket key.
function parseKey(title: string | null, re: RegExp | null): string | null {
  return (re && title?.match(re)?.[0]) || null;
}

function SessionItem({ s, busy, resume, showWs, ticketBase }: {
  s: Session; busy: string | null; resume: (id: string) => void; showWs: boolean; ticketBase: string;
}) {
  return (
    <div className="item">
      <span className={`badge ${s.status}`}>{s.status === "saved" ? "💤 saved" : s.status}</span>
      {s.jira_key && (ticketBase
        ? <a className="jlink" href={ticketBase + s.jira_key} target="_blank" rel="noreferrer">{s.jira_key}</a>
        : <span className="jlink">{s.jira_key}</span>
      )}
      <span className="main">
        <span className="title" title={s.summary ?? undefined}>
          {s.title || "(untitled)"}
          {s.client ? ` · ${s.client}` : ""}
        </span>
        {s.first_prompt && s.first_prompt.trim() !== (s.title ?? "").trim() && (
          <span className="prompt" title={s.first_prompt}>{s.first_prompt}</span>
        )}
      </span>
      {showWs && s.workspace && <span className="ws-tag">{s.workspace}</span>}
      <span className="meta">{shortPath(s.cwd)}</span>
      <span className="meta">{shortDate(s.updated_at)}</span>
      <button className="primary" onClick={() => resume(s.session_id)} disabled={busy === s.session_id || !s.cwd}>
        {busy === s.session_id ? "…" : "▶ Resume"}
      </button>
    </div>
  );
}
