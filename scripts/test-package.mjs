import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const temp = mkdtempSync(path.join(tmpdir(), "codex-web-package-"));
const pack = spawnSync("npm", ["pack", "--pack-destination", temp, "--silent"], { cwd: root, encoding: "utf8" });
assert.equal(pack.status, 0, pack.stderr || pack.stdout);
const filename = pack.stdout.match(/my-codex-web-[^\s]+\.tgz/g)?.at(-1);
assert.ok(filename, "npm pack did not return a filename");
const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", path.join(temp, filename)], { cwd: temp, encoding: "utf8" });
assert.equal(install.status, 0, install.stderr || install.stdout);
const port = 7385;
const child = spawn(path.join(temp, "node_modules/.bin/codex-web"), [], {
  cwd: temp,
  env: { ...process.env, CODEX_WEB_PORT: String(port), CODEX_WEB_OPEN_BROWSER: "0", CODEX_WEB_DATA_DIR: path.join(temp, "data"), CODEX_WEB_CODEX_HOME: path.join(temp, "codex-home") },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { output += String(chunk); });
try {
  const deadline = Date.now() + 30_000;
  let health;
  while (Date.now() < deadline) {
    health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.ok ? response.json() : null).catch(() => null);
    if (health) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(health?.ok, true, `installed codex-web did not start:\n${output}`);
  assert.equal(path.resolve(health.codexHome), path.join(temp, "codex-home"));
  process.stdout.write(`${JSON.stringify({ package: filename, installedCommand: true, health }, null, 2)}\n`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}
