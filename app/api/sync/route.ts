import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

export const dynamic = "force-dynamic";
const pExecFile = promisify(execFile);
const SCRIPT = path.join(process.cwd(), "scripts", "index-sessions.mjs");

export async function POST() {
  try {
    const { stdout, stderr } = await pExecFile("node", [SCRIPT, "--json"], { timeout: 120_000 });
    return NextResponse.json({ ...JSON.parse(stdout), log: stderr.trim() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
