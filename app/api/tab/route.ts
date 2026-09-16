import { NextRequest, NextResponse } from "next/server";
import { openTab, cmux, wakeInTab } from "@/scripts/cmux-lib.mjs";
import { CONFIG } from "@/scripts/db.mjs";
import os from "node:os";

export const dynamic = "force-dynamic";

// POST {workspace, cwd?, command?}                    → open a new cmux tab in that workspace
//                                                       (defaults: claude in the home dir), focus it.
// POST {surface, workspaceRef, rename}                → rename an existing tab.
// POST {surface, workspaceRef, wake_session_id, cwd}  → resume a session inside that idle tab.
export async function POST(req: NextRequest) {
  const body = await req.json();
  if (body.surface && body.workspaceRef && body.wake_session_id) {
    try {
      if (!body.cwd) return NextResponse.json({ error: "cwd required for wake" }, { status: 400 });
      const r = wakeInTab({
        surface: body.surface, workspace: body.workspaceRef,
        sessionId: body.wake_session_id, cwd: body.cwd,
      });
      return NextResponse.json({ ok: true, ...r });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }
  if (body.surface && body.workspaceRef && body.rename) {
    try {
      cmux("rename-tab", "--surface", body.surface, "--workspace", body.workspaceRef, body.rename);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }
  if (!body.workspace) return NextResponse.json({ error: "workspace required" }, { status: 400 });
  try {
    const r = openTab({
      workspaceName: body.workspace,
      cwd: body.cwd || os.homedir(),
      command: body.command || `claude ${CONFIG.claudeFlags}`,
      focus: true,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
