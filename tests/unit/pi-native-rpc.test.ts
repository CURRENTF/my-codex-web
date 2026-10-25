import { createServer } from "node:http";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { PiAdapter } from "../../apps/server/src/pi-adapter.js";
import { ThreadRuntimeRegistry } from "../../apps/server/src/runtime-registry.js";
import type { AdapterEvent } from "@codex-web/codex-adapter";

// Real installed Pi, with an isolated agent directory and a local deterministic provider.
// This verifies the shipped wire protocol and native context restoration without API credentials.
it("deduplicates an installed unified-exec, keeps other extensions, and restores native model context after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-native-rpc-"));
  const agentDir = path.join(root, "agent"); await mkdir(agentDir);
  const plugin = path.join(agentDir, "npm/node_modules/pi-unified-exec");
  const bundled = path.dirname(findPackageJSON("pi-unified-exec", import.meta.url)!);
  await mkdir(plugin, { recursive: true });
  await cp(path.join(bundled, "src"), path.join(plugin, "src"), { recursive: true });
  await cp(path.join(bundled, "package.json"), path.join(plugin, "package.json"));
  await writeFile(path.join(agentDir, "other.ts"), `export default function(pi) { pi.registerTool({ name: "other_extension_tool", label: "Other", description: "Other extension survives", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ok" }] }; } }); }`);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-unified-exec"], extensions: ["./other.ts"] }));
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
    const tools = requests[0].tools.map((tool: any) => tool.function.name);
    expect(tools.filter((name: string) => name === "exec_command")).toHaveLength(1);
    expect(tools).toContain("other_extension_tool");
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

it("resumes an idle Web session when real unified-exec finishes, drains output, and persists the automatic turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-native-wake-"));
  const agentDir = path.join(root, "agent"); await mkdir(agentDir);
  const requests: any[] = [];
  const events: AdapterEvent[] = [];
  const runtimeEvents: string[] = [];
  const registry = new ThreadRuntimeRegistry({ publish: (type: string) => runtimeEvents.push(type) } as never,
    { listThreadUiStates: () => [], clearThreadTerminal: () => {}, markThreadTerminal: () => {} } as never);
  const http = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "wake-test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const tool = (name: string, args: object) => {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      chunk({}, "tool_calls");
    };
    if (requests.length === 1) {
      tool("exec_command", { cmd: "while [ ! -f wake-release ]; do sleep 0.05; done; printf PI_JOB_DONE", yield_time_ms: 250, on_exit: "wake" });
    } else if (requests.length === 3) {
      const wake = input.messages.findLast((message: any) => JSON.stringify(message.content).includes("[unified-exec]"));
      const sessionId = Number(JSON.stringify(wake?.content).match(/session_id=(\d+)/)?.[1]);
      tool("write_stdin", { session_id: sessionId, chars: "", yield_time_ms: 1000 });
    } else {
      chunk({ role: "assistant", content: requests.length === 2 ? "PI_BACKGROUND_ARMED" : "PI_WAKE_DONE" }); chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as { port: number };
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "local-test": {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local-test-key",
    models: [{ id: "test-model", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024 }],
  } } }));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  let pi = new PiAdapter(path.join(root, "sessions"));
  pi.on("event", (event) => { events.push(event); registry.handleEvent(event); });
  try {
    const settings = { model: "local-test/test-model", reasoning: "off", accessMode: "fullAccess" as const };
    const { thread } = await pi.startSession(root, settings);
    await pi.startTurn(thread.id, root, "Run the job; resume when it exits", settings, "human");
    await vi.waitFor(async () => expect((await pi.readSession(thread.id)).turns[0]?.status).toBe("completed"), { timeout: 10_000 });
    expect((await pi.readSession(thread.id)).turns).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[0].tools.some((tool: any) => tool.function.name === "exec_command")).toBe(true);
    expect(registry.get(thread.id).state).not.toBe("running");

    await writeFile(path.join(root, "wake-release"), "release");
    await vi.waitFor(async () => expect((await pi.readSession(thread.id)).turns[1]?.status).toBe("completed"), { timeout: 10_000 });
    const completed = await pi.readSession(thread.id);
    expect(completed.turns).toHaveLength(2);
    expect(completed.turns[1]?.items).toContainEqual(expect.objectContaining({ type: "genericToolCall", title: "pi · unified-exec-completed" }));
    expect(completed.turns[1]?.items).toContainEqual(expect.objectContaining({ type: "agentMessage", text: "PI_WAKE_DONE" }));
    expect(completed.turns[1]?.items.some((item) => item.type === "userMessage")).toBe(false);
    expect(JSON.stringify(requests.at(-1).messages)).toContain("PI_JOB_DONE");
    expect(events.filter((event) => event.type === "turnStarted")).toHaveLength(2);
    expect(runtimeEvents.filter((type) => type === "turn.started")).toHaveLength(2);
    expect(runtimeEvents.filter((type) => type === "turn.completed")).toHaveLength(2);
    expect(registry.get(thread.id).state).not.toBe("running");
    pi.stop();
    pi = new PiAdapter(path.join(root, "sessions"));
    expect(await pi.readSession(thread.id)).toEqual(completed);
  } finally {
    pi.stop(); for (const event of events) if (event.type === "threadStarted") registry.removeThread(event.threadId);
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
