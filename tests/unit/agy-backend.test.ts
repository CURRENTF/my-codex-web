import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyAdapter } from "../../apps/server/src/agy-adapter.js";
import { PiAdapter } from "../../apps/server/src/pi-adapter.js";
import { BackendRouter } from "../../apps/server/src/agent-backend.js";
import { ThreadRuntimeRegistry } from "../../apps/server/src/runtime-registry.js";
import type { AdapterEvent } from "@codex-web/codex-adapter";

const fixture = path.resolve("tests/fixtures/agy-cli.mjs");
const settings = { backend: "agy" as const, model: "fixture-model", reasoning: "default", accessMode: "fullAccess" as const };
const cleanups: Array<() => Promise<void>> = [];
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "agy-test-"));
  const agy = new AgyAdapter(directory, fixture);
  cleanups.push(async () => { await agy.stop(); await rm(directory, { recursive: true, force: true }); });
  const { thread } = await agy.startSession(directory, settings);
  return { agy, directory, id: thread.id };
}
async function settled(agy: AgyAdapter, id: string) {
  await vi.waitFor(async () => expect((await agy.readSession(id)).turns.at(-1)?.status).not.toBe("inProgress"));
  return (await agy.readSession(id)).turns.at(-1)!;
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
describe("agy backend", () => {
  it("streams tools and text and resumes the exact native conversation after restart", async () => {
    const { agy, directory, id } = await setup();
    const events: AdapterEvent[] = []; agy.on("event", (event) => events.push(event));
    await agy.startTurn(id, directory, "ORCHID", settings, "user-1");
    expect((await settled(agy, id)).status).toBe("completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "itemUpserted", item: expect.objectContaining({ type: "genericToolCall", status: "completed" }) }));
    const before = await agy.readSession(id); expect(before.turns[0]?.items).toContainEqual(expect.objectContaining({ type: "agentMessage", text: "hello 世界\u2028agy\n" }));
    await agy.stop();
    const restored = new AgyAdapter(directory, fixture); cleanups.push(() => restored.stop());
    expect(await restored.readSession(id)).toEqual(before);
    await restored.startTurn(id, directory, "recall", settings, "user-2");
    expect((await settled(restored, id)).items).toContainEqual(expect.objectContaining({ type: "agentMessage", text: "ORCHID\n" }));
  });
  it("defaults to Accept Edits and persists explicit Full Access across restart and back to Accept Edits", async () => {
    const { agy, directory, id } = await setup();
    expect((await agy.resumeSession(id)).settings.agyFullAccess).toBe(false);
    await agy.startTurn(id, directory, "permission-mode", settings, "default");
    expect((await settled(agy, id)).items).toContainEqual(expect.objectContaining({ type: "agentMessage", text: "ACCEPT_EDITS\n" }));
    await agy.resumeSession(id, { ...settings, agyFullAccess: true });
    await agy.stop();
    const restored = new AgyAdapter(directory, fixture); cleanups.push(() => restored.stop());
    const persisted = (await restored.resumeSession(id)).settings;
    expect(persisted.agyFullAccess).toBe(true);
    await restored.startTurn(id, directory, "permission-mode", persisted, "enabled");
    expect((await settled(restored, id)).items).toContainEqual(expect.objectContaining({ type: "agentMessage", text: "FULL_ACCESS\n" }));
    const reset = (await restored.resumeSession(id, { ...persisted, agyFullAccess: false })).settings;
    await restored.startTurn(id, directory, "permission-mode", reset, "disabled");
    expect((await settled(restored, id)).items).toContainEqual(expect.objectContaining({ type: "agentMessage", text: "ACCEPT_EDITS\n" }));
  });
  it("interrupts only its own process and can continue afterwards", async () => {
    const { agy, directory, id } = await setup();
    const b = (await agy.startSession(directory, settings)).thread.id;
    const aTurn = await agy.startTurn(id, directory, "hold", settings, "a");
    await agy.startTurn(b, directory, "hold", settings, "b");
    await agy.interruptTurn(id, aTurn.turn.id);
    expect((await agy.readSession(id)).turns[0]?.status).toBe("interrupted");
    expect((await agy.readSession(b)).turns[0]?.status).toBe("inProgress");
    await agy.startTurn(id, directory, "hello", settings, "next");
    expect((await settled(agy, id)).status).toBe("completed");
  });
  it.each(["crash", "malformed", "timeout", "no-result", "error"])("does not report %s as successful", async (prompt) => {
    const { agy, directory, id } = await setup();
    await agy.startTurn(id, directory, prompt, settings, "user");
    const turn = await settled(agy, id);
    expect(turn.status).toBe("failed"); expect(turn.errors?.length).toBeGreaterThan(0);
  });
  it("rejects unsupported capabilities without creating a turn", async () => {
    const { agy, directory, id } = await setup();
    await expect(agy.startTurn(id, directory, "bad", { ...settings, accessMode: "readOnly" }, "user")).rejects.toThrow("沙箱");
    await expect(agy.startTurn(id, directory, "bad", settings, "user", [], [{ kind: "image", path: "/tmp/x.png", name: "x" } as never])).rejects.toThrow("图片");
    await expect(agy.steerTurn(id, "turn", "bad")).rejects.toThrow("Steer");
    expect((await agy.readSession(id)).turns).toEqual([]);
  });
  it("shows native permission errors and rejects SUCCESS with no reply after a denied command", async () => {
    const { agy, directory, id } = await setup();
    await agy.startTurn(id, directory, "denied-command", settings, "user");
    const turn = await settled(agy, id);
    expect(turn.status).toBe("failed");
    expect(turn.errors?.[0]?.message).toContain("未获授权");
    expect(turn.items).toContainEqual(expect.objectContaining({ type: "genericToolCall", status: "failed", details: expect.stringContaining("user denied permission") }));
    await agy.stop();
    const restored = new AgyAdapter(directory, fixture); cleanups.push(() => restored.stop());
    expect((await restored.readSession(id)).turns[0]?.status).toBe("failed");
  });
  it("keeps a completed reply after an explained tool error successful and repairs older silent failures", async () => {
    const { agy, directory, id } = await setup();
    await agy.startTurn(id, directory, "recovered-tool-error", settings, "first");
    expect((await settled(agy, id)).status).toBe("completed");
    await agy.startTurn(id, directory, "denied-command", settings, "second");
    await settled(agy, id); await agy.stop();
    const { readFile, writeFile } = await import("node:fs/promises");
    const file = path.join(directory, `${id.slice(4)}.web.json`);
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.thread.turns[1].status = "completed"; delete saved.thread.turns[1].errors;
    await writeFile(file, JSON.stringify(saved));
    const restored = new AgyAdapter(directory, fixture); cleanups.push(() => restored.stop());
    const turns = (await restored.readSession(id)).turns;
    expect(turns[0]?.status).toBe("completed");
    expect(turns[1]?.status).toBe("failed");
    expect(turns[1]?.errors?.[0]?.message).toContain("工具执行失败");
  });
  it("routes all three backends independently and survives Codex disconnect", async () => {
    const { agy, directory, id } = await setup();
    const codex = Object.assign(new EventEmitter(), { connected: false, startTurn: vi.fn(async () => ({ turn: { id: "codex-turn" } })) });
    const pi = new PiAdapter(path.join(directory, "pi"), path.resolve("tests/fixtures/pi-rpc.mjs"));
    cleanups.push(async () => { pi.stop(); });
    const router = new BackendRouter(codex as never, pi, agy);
    const registry = new ThreadRuntimeRegistry({ publish: vi.fn() } as never, { listThreadUiStates: () => [], clearThreadTerminal: () => {}, markThreadTerminal: () => {} } as never);
    router.on("event", (event) => registry.handleEvent(event));
    await router.startTurn(id, directory, "hold", settings, "agy-user");
    registry.handleConnection("disconnected", "codex");
    expect(registry.get(id).state).toBe("running");
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(() => router.startReview(id, { type: "uncommittedChanges" })).toThrow("agy 暂不支持");
    expect((await router.readSessionCost(id)).status).toBe("unsupported");
  });
  it("marks missing CLI unavailable without exposing diagnostics", async () => {
    const { directory } = await setup();
    const missing = new AgyAdapter(path.join(directory, "missing"), "/nonexistent/agy");
    expect(await missing.describe()).toMatchObject({ id: "agy", available: false, models: [] });
  });
});
