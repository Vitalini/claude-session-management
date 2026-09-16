import { NextRequest, NextResponse } from "next/server";
import { hibernateTab, focusedTab } from "@/scripts/cmux-lib.mjs";

export const dynamic = "force-dynamic";

// POST {surface, workspace}  → save that tab's session and close the tab.
// POST {current: true}       → same for the tab currently focused in cmux.
export async function POST(req: NextRequest) {
  const body = await req.json();
  try {
    let surface = body.surface as string | undefined;
    let workspace = body.workspace as string | undefined;
    if (body.current) {
      const f = focusedTab();
      if (!f || f.is_browser_surface) {
        return NextResponse.json(
          { error: "The focused cmux tab is not a terminal — focus the tab you want and retry." },
          { status: 409 }
        );
      }
      surface = f.surface_ref;
      workspace = f.workspace_ref;
    }
    if (!surface || !workspace) {
      return NextResponse.json({ error: "surface + workspace (or current:true) required" }, { status: 400 });
    }
    const r = hibernateTab({
      surface, workspace,
      sessionIdHint: body.session_id ?? null,
      cwdHint: body.cwd ?? null,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
