import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const agentDir = path.join(temp, "pi-agent");
mkdirSync(agentDir);
writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "package-test": {
  baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "unused-local-test",
  models: [{ id: "test-model", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
} } }));
const child = spawn(path.join(temp, "node_modules/.bin/codex-web"), [], {
  cwd: temp,
  env: { ...process.env, CODEX_WEB_PORT: String(port), CODEX_WEB_OPEN_BROWSER: "0", CODEX_WEB_DATA_DIR: path.join(temp, "data"), CODEX_WEB_CODEX_HOME: path.join(temp, "codex-home"), PI_CODING_AGENT_DIR: path.join(temp, "pi-agent"), CODEX_WEB_AGY_BIN: path.join(temp, "missing-agy") },
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
  const bootstrapResponse = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
  const bootstrap = await bootstrapResponse.json();
  const pi = bootstrap.backends?.find((backend) => backend.id === "pi");
  assert.ok(pi && Array.isArray(pi.models), "installed package did not expose Pi");
  assert.ok(pi.available || pi.message?.includes("尚无可用模型"), `bundled Pi failed to start: ${pi.message}`);
  const headers = { "content-type": "application/json", "x-csrf-token": bootstrap.csrfToken,
    origin: `http://127.0.0.1:${port}`, cookie: bootstrapResponse.headers.get("set-cookie").split(";")[0] };
  const project = await fetch(`http://127.0.0.1:${port}/api/projects`, { method: "POST", headers,
    body: JSON.stringify({ path: temp, clientRequestId: crypto.randomUUID() }) }).then((response) => response.json());
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/sessions`, { method: "POST", headers,
    body: JSON.stringify({ backend: "pi", model: "package-test/test-model", reasoning: "off", clientRequestId: crypto.randomUUID() }) });
  assert.equal(sessionResponse.status, 200, `installed Pi session/plugin failed: ${await sessionResponse.text()}`);
  assert.equal(bootstrap.backends?.find((backend) => backend.id === "agy")?.available, false, "missing optional agy must not prevent startup");
  process.stdout.write(`${JSON.stringify({ package: filename, installedCommand: true, bundledPiRpc: true, unifiedExecLoaded: true, health }, null, 2)}\n`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}
