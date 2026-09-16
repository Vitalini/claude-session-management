import { NextRequest, NextResponse } from "next/server";
import { resumeSessionTab, focusTab } from "@/scripts/cmux-lib.mjs";

export const dynamic = "force-dynamic";

// POST {session_id} → resume a cold session in a new cmux tab.
// POST {workspace, surface} → focus an already-open tab.
export async function POST(req: NextRequest) {
  const body = await req.json();
  try {
    if (body.session_id) {
      const r = resumeSessionTab(body.session_id, { focus: true });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.workspace) {
      focusTab({ workspace: body.workspace, surface: body.surface });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "session_id or workspace required" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
