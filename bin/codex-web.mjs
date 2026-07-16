#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [path.join(root, "apps/server/dist/index.js")], {
  cwd: root,
  env: { ...process.env, CODEX_WEB_OPEN_BROWSER: process.env.CODEX_WEB_OPEN_BROWSER ?? "1" },
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exitCode = signal ? 1 : (code ?? 1));
