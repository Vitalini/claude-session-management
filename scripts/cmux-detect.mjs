// Locate the cmux CLI. Dependency-free on purpose: setup.mjs runs this before
// `npm install`, and cmux-lib.mjs reuses it at runtime when config.cmuxBin is empty.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export const CMUX_APP_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";

export function detectCmuxBin() {
  if (fs.existsSync(CMUX_APP_BIN)) return CMUX_APP_BIN;
  try {
    const found = execFileSync("/usr/bin/which", ["cmux"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {}
  return null;
}
