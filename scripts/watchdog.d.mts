export function resumeIncident(id: number, via?: string): Promise<{ surface: string | null; workspace: string }>;
export function parseUsage(screen: string | null): { pct: number; resetsInMin: number; resetAt: string } | null;
export function classifyScreen(screen: string | null): { kind: string; reason: string };
