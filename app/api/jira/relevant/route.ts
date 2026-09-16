import { NextResponse } from "next/server";
import { CONFIG, searchSessions } from "@/scripts/db.mjs";
import { ticketsEnabled, ticketBaseUrl, ticketUrl } from "@/scripts/tickets.mjs";

export const dynamic = "force-dynamic";

type SessionRow = { session_id: string; status: string; updated_at: string };

// Relevant tickets for the dashboard, via the tracker's Jira-compatible REST API.
// Ticket tracking is optional: off, or without credentials, means no ticket list,
// which is an empty result for the dashboard, not a failure.
export async function GET() {
  const baseUrl = ticketBaseUrl();
  const email = process.env.TICKET_EMAIL ?? process.env.JIRA_EMAIL;
  const token = process.env.TICKET_API_TOKEN ?? process.env.JIRA_API_TOKEN;
  if (!ticketsEnabled() || !baseUrl || !email || !token) return NextResponse.json({ issues: [] });
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  try {
    const res = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jql: CONFIG.tickets.relevantJql,
        maxResults: CONFIG.tickets.maxRelevant,
        fields: ["summary", "status", "duedate", "priority", "updated"],
      }),
    });
    if (!res.ok) return NextResponse.json({ issues: [], error: `Tracker ${res.status}` });
    const data = await res.json();
    const issues = (data.issues ?? []).map((i: { key: string; fields: Record<string, unknown> }) => {
      const sessions = (searchSessions(i.key, { limit: 3 }) as SessionRow[]).map((s) => ({
        session_id: s.session_id, status: s.status, updated_at: s.updated_at,
      }));
      return {
        key: i.key,
        summary: (i.fields as { summary?: string }).summary,
        status: (i.fields as { status?: { name?: string } }).status?.name,
        duedate: (i.fields as { duedate?: string }).duedate,
        priority: (i.fields as { priority?: { name?: string } }).priority?.name,
        updated: (i.fields as { updated?: string }).updated,
        url: ticketUrl(i.key),
        sessions,
      };
    });
    return NextResponse.json({ issues, jql: CONFIG.tickets.relevantJql });
  } catch (e) {
    return NextResponse.json({ issues: [], error: String(e) });
  }
}
