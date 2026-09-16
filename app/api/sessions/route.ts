import { NextRequest, NextResponse } from "next/server";
import { searchSessions, statusCounts } from "@/scripts/db.mjs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const workspace = req.nextUrl.searchParams.get("workspace") ?? undefined;
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
  return NextResponse.json({
    sessions: searchSessions(q, { limit, status, workspace }),
    counts: statusCounts(),
  });
}
