import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

export const dynamic = "force-dynamic";
const pExecFile = promisify(execFile);
const SCRIPT = path.join(process.cwd(), "scripts", "index-sessions.mjs");

let cache: { at: number; data: unknown } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < 5_000) return NextResponse.json(cache.data);
  try {
    const { stdout } = await pExecFile("node", [SCRIPT, "--live", "--json"], { timeout: 30_000 });
    const data = JSON.parse(stdout);
    cache = { at: Date.now(), data };
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ tabs: null, error: String(e) }, { status: 502 });
  }
}
