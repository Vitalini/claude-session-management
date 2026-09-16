import { NextRequest, NextResponse } from "next/server";
import { CONFIG } from "@/scripts/db.mjs";

export const dynamic = "force-dynamic";

let cache: { at: number; key: string; data: unknown } | null = null;

// GET ?keys=PS-1,PS-2 → { "PS-1": { status, category } } — batch Jira status
// lookup so the dashboard can suggest hibernating sessions whose ticket is done.
export async function GET(req: NextRequest) {
  // Jira is optional: with no base URL or no credentials the dashboard simply
  // shows no ticket statuses, so answer 200 with nothing rather than an error.
  const baseUrl = (CONFIG.jira?.baseUrl ?? "").replace(/\/+$/, "");
  const keysParam = req.nextUrl.searchParams.get("keys") ?? "";
  const keys = [...new Set(keysParam.split(",").map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9]+-\d+$/.test(k)))];
  if (!keys.length) return NextResponse.json({ statuses: {} });

  const cacheKey = keys.sort().join(",");
  if (cache && cache.key === cacheKey && Date.now() - cache.at < 120_000) {
    return NextResponse.json(cache.data);
  }

  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !token) return NextResponse.json({ statuses: {} });
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  try {
    const res = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jql: `key in (${keys.join(",")})`,
        maxResults: keys.length,
        fields: ["status"],
      }),
    });
    if (!res.ok) return NextResponse.json({ statuses: {}, error: `Jira ${res.status}` });
    const data = await res.json();
    const statuses: Record<string, { status: string; category: string }> = {};
    for (const i of data.issues ?? []) {
      const st = i.fields?.status;
      statuses[i.key] = { status: st?.name ?? "?", category: st?.statusCategory?.key ?? "?" };
    }
    const payload = { statuses };
    cache = { at: Date.now(), key: cacheKey, data: payload };
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json({ statuses: {}, error: String(e) });
  }
}
