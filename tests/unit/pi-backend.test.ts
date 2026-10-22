import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAdapter } from "../../apps/server/src/pi-adapter.js";
import { BackendRouter } from "../../apps/server/src/agent-backend.js";
import { ThreadRuntimeRegistry } from "../../apps/server/src/runtime-registry.js";
import type { AdapterEvent, AdapterPendingRequest } from "@codex-web/codex-adapter";

const settings = { model: "test/local", reasoning: "off", accessMode: "fullAccess" as const };
const fixture = path.resolve("tests/fixtures/pi-rpc.mjs");
const cleanups: Array<() => Promise<void>> = [];
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "web-pi-test-"));
  const pi = new PiAdapter(directory, fixture);
  cleanups.push(async () => { pi.stop(); await rm(directory, { recursive: true, force: true }); });
  return { pi, directory };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe("per-session Pi backend", () => {
  it("routes simultaneous Codex and Pi sessions without changing the default backend", async () => {
    const { pi, directory } = await setup();
    const codex = Object.assign(new EventEmitter(), { connected: true, startSession: vi.fn(async () => ({ thread: { id: "codex-id" } })), startTurn: vi.fn(async () => ({ turn: { id: "codex-turn" } })), getGoal: vi.fn(async () => null) });
    const router = new BackendRouter(codex as never, pi);
    expect((await router.startSession(directory, settings)).thread.id).toBe("codex-id");
    const { thread } = await router.startSession(directory, { ...settings, backend: "pi" });
    expect(thread.id).toMatch(/^pi:/);
    await router.startTurn(thread.id, directory, "hold", settings, "user-pi");
    await router.startTurn("codex-id", directory, "hello", settings, "user-codex");
    expect(codex.startSession).toHaveBeenCalledTimes(1);
    expect(codex.startTurn).toHaveBeenCalledWith("codex-id", directory, "hello", settings, "user-codex");
    expect((await router.readSession(thread.id)).turns[0]?.status).toBe("inProgress");
    expect(await router.getGoal(thread.id)).toBeNull();
    expect(() => router.startReview(thread.id, { type: "uncommittedChanges" })).toThrow("pi 暂不支持");
  });
  it("streams tools and Unicode text, waits for settled, and restores history after restart", async () => {
    const { pi, directory } = await setup();
    const events: AdapterEvent[] = []; pi.on("event", (event) => events.push(event));
    const { thread } = await pi.startSession(directory, settings);
    await pi.startTurn(thread.id, directory, "hello", settings, "user-1");
    await vi.waitFor(() => expect(events.some((event) => event.type === "itemUpserted" && event.item.type === "genericToolCall")).toBe(true), { interval: 10 });
    expect((await pi.readSession(thread.id)).turns[0]?.status).toBe("inProgress");
    await vi.waitFor(async () => expect((await pi.readSession(thread.id)).turns[0]?.status).toBe("completed"));
    const before = await pi.readSession(thread.id);
    expect(before.turns[0]?.items).toContainEqual(expect.objectContaining({ type: "agentMessage", text: "hello\u2028world" }));
    pi.stop();
    const restored = new PiAdapter(directory, fixture);
    cleanups.push(async () => { restored.stop(); });
    expect((await restored.readSession(thread.id))).toEqual(before);
    expect((await restored.resumeSession(thread.id)).settings.model).toBe("test/local");
    const next = await restored.startTurn(thread.id, directory, "handled", settings, "user-2");
    expect(next.turn.status).toBe("completed");
    restored.stop();
  });
  it("interrupts only the selected session, persists interruption, and rejects false sandbox promises", async () => {
    const { pi, directory } = await setup();
    await expect(pi.startSession(directory, { ...settings, accessMode: "readOnly" })).rejects.toThrow("沙箱");
    const a = await pi.startSession(directory, settings), b = await pi.startSession(directory, settings);
    const ta = await pi.startTurn(a.thread.id, directory, "hold", settings, "a");
    await pi.startTurn(b.thread.id, directory, "hold", settings, "b");
    await pi.interruptTurn(a.thread.id, ta.turn.id);
    expect((await pi.readSession(a.thread.id)).turns[0]?.status).toBe("interrupted");
    expect((await pi.readSession(b.thread.id)).turns[0]?.status).toBe("inProgress");
  });
  it("terminalizes an unexpectedly exited child and permits a new process on retry", async () => {
    const { pi, directory } = await setup();
    const { thread } = await pi.startSession(directory, settings);
    await pi.startTurn(thread.id, directory, "crash", settings, "first");
    await vi.waitFor(async () => expect((await pi.readSession(thread.id)).turns[0]?.status).toBe("failed"));
    expect((await pi.startTurn(thread.id, directory, "handled", settings, "second")).turn.status).toBe("completed");
  });
  it("forwards Pi extension questions to the existing user-input channel", async () => {
    const { pi, directory } = await setup(); let question: AdapterPendingRequest | undefined;
    pi.on("pendingRequest", (value) => { question = value; });
    const { thread } = await pi.startSession(directory, settings);
    await pi.startTurn(thread.id, directory, "question", settings, "user");
    await vi.waitFor(() => expect(question).toBeDefined());
    expect(question?.summary.params?.type).toBe("userInput");
    pi.respondPendingRequest(question!.id, true, { answer: ["拒绝"] });
    await vi.waitFor(async () => expect((await pi.readSession(thread.id)).turns[0]?.status).toBe("completed"));
  });
  it("keeps Pi runtimes and pending input alive during a Codex disconnect", () => {
    const publish = vi.fn();
    const registry = new ThreadRuntimeRegistry({ publish } as never, { listThreadUiStates: () => [], clearThreadTerminal: () => {} } as never);
    const turn = { id: "turn", status: "inProgress" as const, items: [], startedAt: 1, completedAt: null, durationMs: null };
    registry.handleEvent({ type: "turnStarted", threadId: "pi:test", turn });
    registry.handleEvent({ type: "turnStarted", threadId: "codex-test", turn });
    registry.handleConnection("disconnected", "codex");
    expect(registry.get("pi:test").state).toBe("running");
    expect(registry.get("codex-test").state).toBe("disconnected");
    expect(publish).toHaveBeenCalledWith("backend.connection.changed", { backend: "codex", state: "disconnected" });
  });
});
