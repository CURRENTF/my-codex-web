import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const expected = readFileSync(path.join(root, "packages/codex-schema/CODEX_VERSION"), "utf8").trim();
const actual = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
if (actual !== expected) {
  console.error(`Codex schema version mismatch: generated with ${expected}, current ${actual}`);
  process.exit(1);
}
console.log(`Codex schema version OK: ${actual}`);
