export function dirExists(p: string | null | undefined): boolean;
export function expandHome(p: string | null | undefined): string;
export function configuredAliases(): Record<string, string>;
export function applyAliases(dir: string | null | undefined, aliases?: Record<string, string>): string | null;
export function resolveCwd(
  cwd: string | null | undefined,
  opts?: { aliases?: Record<string, string> }
): { dir: string; note: string | null };
