import { NextResponse } from "next/server";
import { CONFIG } from "@/scripts/db.mjs";

export const dynamic = "force-dynamic";

// Client-safe slice of config.json. Jira links only exist when a base URL is set.
export async function GET() {
  const baseUrl = (CONFIG.jira?.baseUrl ?? "").replace(/\/+$/, "");
  return NextResponse.json({
    jiraBaseUrl: baseUrl,
    jiraEnabled: Boolean(baseUrl),
    defaultWorkspace: CONFIG.defaultWorkspace ?? "",
  });
}
