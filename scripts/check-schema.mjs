import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const expectedVersion = readFileSync(path.join(root, "packages/codex-schema/CODEX_VERSION"), "utf8").trim();
const actualVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
if (actualVersion !== expectedVersion) {
  console.error(`Codex schema version mismatch: generated with ${expectedVersion}, current ${actualVersion}`);
  process.exit(1);
}

const temporary = mkdtempSync(path.join(os.tmpdir(), "codex-web-schema-check-"));
const home = path.join(temporary, "codex-home");
const generatedTs = path.join(temporary, "generated");
const generatedJson = path.join(temporary, "json");
const env = { ...process.env, CODEX_HOME: home };
mkdirSync(home, { recursive: true, mode: 0o700 });

function filesBelow(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? filesBelow(path.join(directory, entry.name), relative) : [relative];
  }).sort();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalJson(child)]));
  return value;
}

function equalFile(expectedPath, actualPath, semanticJson) {
  if (!semanticJson) return readFileSync(expectedPath).equals(readFileSync(actualPath));
  return JSON.stringify(canonicalJson(JSON.parse(readFileSync(expectedPath, "utf8")))) === JSON.stringify(canonicalJson(JSON.parse(readFileSync(actualPath, "utf8"))));
}

function compareDirectories(expectedDirectory, actualDirectory, label, semanticJson = false) {
  const expectedFiles = filesBelow(expectedDirectory);
  const actualFiles = filesBelow(actualDirectory);
  const mismatches = [];
  for (const file of new Set([...expectedFiles, ...actualFiles])) {
    if (!expectedFiles.includes(file)) mismatches.push(`${label}: unexpected ${file}`);
    else if (!actualFiles.includes(file)) mismatches.push(`${label}: missing ${file}`);
    else if (!equalFile(path.join(expectedDirectory, file), path.join(actualDirectory, file), semanticJson)) mismatches.push(`${label}: changed ${file}`);
  }
  return mismatches;
}

try {
  execFileSync("codex", ["app-server", "generate-ts", "--out", generatedTs], { stdio: "inherit", env });
  execFileSync("codex", ["app-server", "generate-json-schema", "--out", generatedJson], { stdio: "inherit", env });
  const mismatches = [
    ...compareDirectories(path.join(root, "packages/codex-schema/generated"), generatedTs, "TypeScript schema"),
    ...compareDirectories(path.join(root, "packages/codex-schema/json"), generatedJson, "JSON schema", true),
  ];
  if (mismatches.length) {
    console.error(`Generated Codex schema differs from the committed schema:\n${mismatches.slice(0, 100).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`Codex schema and version are current: ${actualVersion}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
