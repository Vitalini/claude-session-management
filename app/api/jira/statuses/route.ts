import { NextRequest, NextResponse } from "next/server";
import { ticketsEnabled, ticketBaseUrl, ticketKeyExact } from "@/scripts/tickets.mjs";

export const dynamic = "force-dynamic";

let cache: { at: number; key: string; data: unknown } | null = null;

// GET ?keys=PROJ-1,PROJ-2 → { "PROJ-1": { status, category } } — batch ticket
// status lookup so the dashboard can suggest hibernating sessions whose ticket
// is done. Ticket tracking is optional: off, or without credentials, the
// dashboard simply shows no statuses, so answer 200 with nothing, not an error.
export async function GET(req: NextRequest) {
  const baseUrl = ticketBaseUrl();
  const keysParam = req.nextUrl.searchParams.get("keys") ?? "";
  const keys = [...new Set(
    keysParam.split(",").map((k) => ticketKeyExact(k)).filter(Boolean) as string[]
  )];
  if (!keys.length) return NextResponse.json({ statuses: {} });

  const cacheKey = keys.sort().join(",");
  if (cache && cache.key === cacheKey && Date.now() - cache.at < 120_000) {
    return NextResponse.json(cache.data);
  }

  const email = process.env.TICKET_EMAIL ?? process.env.JIRA_EMAIL;
  const token = process.env.TICKET_API_TOKEN ?? process.env.JIRA_API_TOKEN;
  if (!ticketsEnabled() || !baseUrl || !email || !token) return NextResponse.json({ statuses: {} });
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
    if (!res.ok) return NextResponse.json({ statuses: {}, error: `Tracker ${res.status}` });
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
