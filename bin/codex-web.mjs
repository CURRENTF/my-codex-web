#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseEntry = path.join(root, ".release/server.mjs");
const entry = existsSync(releaseEntry) ? releaseEntry : path.join(root, "apps/server/dist/index.js");
const child = spawn(process.execPath, [entry], {
  cwd: root,
  env: { ...process.env, CODEX_WEB_PROJECT_ROOT: root, CODEX_WEB_OPEN_BROWSER: process.env.CODEX_WEB_OPEN_BROWSER ?? "1" },
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exitCode = signal ? 1 : (code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
