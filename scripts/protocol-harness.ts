import { CodexAdapter } from "@codex-web/codex-adapter";

const codexHome = process.env.CODEX_WEB_TEST_CODEX_HOME;
if (!codexHome) throw new Error("Set CODEX_WEB_TEST_CODEX_HOME to an isolated directory");
const adapter = new CodexAdapter({ cwd: process.cwd(), codexHome, version: "protocol-harness" });
adapter.on("stderr", (line) => process.stderr.write(`[app-server] ${String(line)}`));
await adapter.start();
try {
  const account = await adapter.readAccount();
  const sessions = await adapter.listSessions({ limit: 10 });
  console.log(JSON.stringify({ authenticated: account.account !== null, modelCount: adapter.models.length, sessionCount: sessions.data.length }, null, 2));
} finally {
  adapter.stop();
}
