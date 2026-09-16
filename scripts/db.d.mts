export const DB_PATH: string;
export const CONFIG_PATH: string;
export const CONFIG: {
  port: number;
  language: string;
  tickets: {
    enabled: boolean;
    baseUrl: string;
    browsePath: string;
    projectKeys: string[];
    relevantJql: string;
    maxRelevant: number;
  };
  phrases: { scoping: string; task: string; updates: string };
  cmuxBin: string;
  claudeFlags: string;
  defaultWorkspace: string;
  scopingWorkspace: string;
  claudeProjectsDir: string;
};

export interface SessionRow {
  session_id: string;
  cwd: string | null;
  title: string | null;
  jira_key: string | null;
  client: string | null;
  workspace: string | null;
  status: string;
  summary: string | null;
  todos: string | null;
  resume_command: string | null;
  last_prompt: string | null;
  first_prompt: string | null;
  git_branch: string | null;
  pr_url: string | null;
  message_count: number | null;
  created_at: string | null;
  updated_at: string | null;
  saved_at: string | null;
}

export function getDb(): unknown;
export function upsertSession(row: Partial<SessionRow> & { session_id: string }): "inserted" | "updated" | "unchanged";
export function getSession(sessionId: string): SessionRow | undefined;
export function searchSessions(q: string, opts?: { limit?: number; status?: string; workspace?: string }): SessionRow[];
export function statusCounts(): { status: string; n: number }[];
export function workspaceCounts(): { workspace: string; status: string; n: number }[];

export interface Incident {
  id: number;
  session_id: string | null;
  surface: string | null;
  workspace_ref: string | null;
  workspace: string | null;
  title: string | null;
  cwd: string | null;
  kind: string;
  detected_at: string;
  reset_at: string | null;
  screen: string | null;
  analysis: string | null;
  status: string;
  decided_at: string | null;
  decided_via: string | null;
  tg_message_id: number | null;
  snooze_until: string | null;
}
export function pendingIncidents(): Incident[];
export function recentIncidents(limit?: number): Incident[];
export function getIncident(id: number): Incident | undefined;
export function updateIncident(id: number, fields: Record<string, unknown>): void;
export function createIncident(row: Record<string, unknown>): number;
export function openIncidentFor(sessionId: string, kind: string): Incident | undefined;
export function getTabState(surface: string): Record<string, unknown> | undefined;
export function allTabStates(): Record<string, unknown>[];
export function saveTabState(row: Record<string, unknown>): void;
export function dropTabState(surface: string): void;
export function parseTabTitle(title: string | null | undefined): { jira_key: string | null; client: string | null };
