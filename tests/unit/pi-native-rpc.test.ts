import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { PiAdapter } from "../../apps/server/src/pi-adapter.js";

// Real installed Pi, with an isolated agent directory and a local deterministic provider.
// This verifies the shipped wire protocol and native context restoration without API credentials.
it("runs the bundled Pi RPC and restores native model context after Web restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-native-rpc-"));
  const agentDir = path.join(root, "agent"); await mkdir(agentDir);
  const requests: any[] = [];
  const http = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "local-test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant", content: "PI_NATIVE_OK" }); chunk({}, "stop"); response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as { port: number };
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "local-test": {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-test-key",
    models: [{ id: "test-model", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
  } } }));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const settings = { model: "local-test/test-model", reasoning: "off", accessMode: "fullAccess" as const };
  let pi = new PiAdapter(path.join(root, "sessions"));
  try {
    const description = await pi.describe();
    expect(description.available, description.message).toBe(true);
    expect(description.models.some((model) => model.model === settings.model)).toBe(true);
    const { thread } = await pi.startSession(root, settings);
    await pi.startTurn(thread.id, root, "Remember native-context-marker", settings, "first-user");
    await vi.waitFor(async () => expect((await pi.readSession(thread.id)).turns[0]?.status).toBe("completed"), { timeout: 10_000 });
    expect((await pi.readSession(thread.id)).turns[0]?.items).toContainEqual(expect.objectContaining({ type: "agentMessage", text: "PI_NATIVE_OK" }));
    await pi.unsubscribe(thread.id); pi.stop();
    pi = new PiAdapter(path.join(root, "sessions"));
    await pi.resumeSession(thread.id);
    await pi.startTurn(thread.id, root, "Continue", settings, "second-user");
    await vi.waitFor(async () => expect((await pi.readSession(thread.id)).turns[1]?.status).toBe("completed"), { timeout: 10_000 });
    expect(JSON.stringify(requests.at(-1).messages)).toContain("native-context-marker");
    expect(JSON.stringify(requests.at(-1).messages)).toContain("PI_NATIVE_OK");
  } finally {
    pi.stop(); http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve()));
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
