import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
}

export function requireIsolatedCodexHome(value: string | undefined, variableName: string): string {
  if (!value) throw new Error(`${variableName} must point to an isolated test directory`);
  const resolved = path.resolve(value);
  mkdirSync(resolved, { recursive: true });
  const canonical = canonicalPath(resolved);
  const normalHomes = [path.join(homedir(), ".codex"), process.env.CODEX_HOME, process.env.CODEX_WEB_CODEX_HOME]
    .filter((candidate): candidate is string => !!candidate)
    .map(canonicalPath);
  if (normalHomes.includes(canonical)) {
    throw new Error(`Refusing to use the normal Codex home from ${variableName}`);
  }
  return canonical;
}
