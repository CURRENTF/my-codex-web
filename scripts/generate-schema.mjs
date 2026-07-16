import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const home = path.join(root, ".runtime", "schema-codex-home");
const tsOut = path.join(root, "packages/codex-schema/generated");
const jsonOut = path.join(root, "packages/codex-schema/json");
mkdirSync(home, { recursive: true });
mkdirSync(tsOut, { recursive: true });
mkdirSync(jsonOut, { recursive: true });
const env = { ...process.env, CODEX_HOME: home };
execFileSync("codex", ["app-server", "generate-ts", "--out", tsOut], { stdio: "inherit", env });
execFileSync("codex", ["app-server", "generate-json-schema", "--out", jsonOut], { stdio: "inherit", env });
const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
writeFileSync(path.join(root, "packages/codex-schema/CODEX_VERSION"), `${version}\n`);
