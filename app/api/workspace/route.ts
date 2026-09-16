import { NextRequest, NextResponse } from "next/server";
import { cmux } from "@/scripts/cmux-lib.mjs";
import { execFileSync } from "node:child_process";
import os from "node:os";

export const dynamic = "force-dynamic";

// POST {name}          → create a new cmux workspace (plain shell, home dir)
// POST {ref, rename}   → rename an existing workspace
export async function POST(req: NextRequest) {
  const body = await req.json();
  try {
    if (body.ref && body.rename) {
      cmux("rename-workspace", "--workspace", body.ref, body.rename);
      return NextResponse.json({ ok: true });
    }
    if (body.name) {
      const out = cmux("new-workspace", "--name", body.name, "--cwd", os.homedir(), "--focus", "true");
      try { execFileSync("open", ["-a", "cmux"]); } catch {}
      return NextResponse.json({ ok: true, workspace: out.match(/workspace:\d+/)?.[0] ?? null });
    }
    return NextResponse.json({ error: "name (create) or ref+rename required" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
