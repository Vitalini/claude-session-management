import { NextRequest, NextResponse } from "next/server";
import { pendingIncidents, recentIncidents, updateIncident, getIncident } from "@/scripts/db.mjs";
import { resumeIncident } from "@/scripts/watchdog.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ pending: pendingIncidents(), recent: recentIncidents(20) });
}

// POST {id, action: "resume" | "dismiss" | "snooze"}
export async function POST(req: NextRequest) {
  const { id, action } = await req.json();
  if (!id || !action) return NextResponse.json({ error: "id + action required" }, { status: 400 });
  if (!getIncident(id)) return NextResponse.json({ error: "incident not found" }, { status: 404 });
  try {
    if (action === "resume") {
      // Returns as soon as the tab is launched; the follow-up nudge lands a
      // minute later, once claude's prompt is actually up.
      const where = await resumeIncident(id, "dashboard");
      return NextResponse.json({ ok: true, ...where });
    }
    if (action === "dismiss") {
      updateIncident(id, { status: "dismissed", decided_at: new Date().toISOString(), decided_via: "dashboard" });
      return NextResponse.json({ ok: true });
    }
    if (action === "snooze") {
      updateIncident(id, { status: "snoozed", snooze_until: new Date(Date.now() + 3600_000).toISOString() });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: `unknown action ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
