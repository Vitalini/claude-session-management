import { NextResponse } from "next/server";
import { CONFIG } from "@/scripts/db.mjs";
import { ticketsEnabled, ticketBaseUrl, ticketKeyPattern } from "@/scripts/tickets.mjs";

export const dynamic = "force-dynamic";

// Client-safe slice of config.json. Ticket tracking is optional: with it off the
// dashboard gets no base URL and no key pattern, and shows no ticket UI at all.
export async function GET() {
  const enabled = ticketsEnabled();
  return NextResponse.json({
    ticketsEnabled: enabled,
    ticketBaseUrl: ticketBaseUrl(),
    // Normalized to /…/ so the client can concatenate it, exactly like ticketUrl().
    ticketBrowsePath: `/${String(CONFIG.tickets?.browsePath ?? "/browse/").replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/"),
    // Omitted entirely when tracking is off — there is no key shape to publish.
    ...(enabled ? { ticketKeyPattern: ticketKeyPattern() } : {}),
    defaultWorkspace: CONFIG.defaultWorkspace ?? "",
  });
}
