export const CMUX_BIN: string;
export const FALLBACK_WORKSPACE: string;
export function detectCmuxBin(): string | null;
export function cmux(...args: string[]): string;
export function listWorkspaces(): { ref: string; name: string }[];
export function openTab(opts: {
  workspaceName?: string | null;
  cwd: string;
  command: string;
  title?: string | null;
  focus?: boolean;
}): { workspace: string; surface: string | null };
export function resumeSessionTab(sessionId: string, opts?: { focus?: boolean; prompt?: string }): { workspace: string; surface: string | null };
export function focusTab(opts: { workspace?: string | null; surface?: string | null }): void;
export function focusedTab(): { surface_ref: string; workspace_ref: string; is_browser_surface: boolean } | null;
export function wakeInTab(opts: { surface: string; workspace: string; sessionId: string; cwd: string }): { surface: string; workspace: string };
export function hibernateTab(opts: { surface: string; workspace: string; sessionIdHint?: string | null; cwdHint?: string | null }): {
  session_id: string; title: string | null; workspace: string | null;
};
