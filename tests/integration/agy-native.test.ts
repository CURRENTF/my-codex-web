import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { AgyAdapter } from "../../apps/server/src/agy-adapter.js";

it.skipIf(process.env.RUN_AGY_INTEGRATION !== "1")("native agy edits a file, restores context across adapter recreation, and confirms interrupt", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "web-agy-native-"));
  const command = process.env.CODEX_WEB_AGY_BIN ?? "agy";
  let adapter = new AgyAdapter(path.join(directory, "metadata"), command);
  const settings = { model: "gemini-3.8-flash-high", reasoning: "default", accessMode: "fullAccess" as const };
  const token = `orchid-${Date.now()}`;
  try {
    const { thread } = await adapter.startSession(directory, settings);
    await adapter.startTurn(thread.id, directory, `Write the exact word ${token} into ${directory}/probe.txt using the file writing tool, then reply only SAVED. Do not perform other operations.`, settings, "first");
    await vi.waitFor(async () => expect((await adapter.readSession(thread.id)).turns[0]?.status).toBe("completed"), { timeout: 90_000, interval: 200 });
    expect((await readFile(path.join(directory, "probe.txt"), "utf8")).trim()).toBe(token);
    await adapter.stop();
    adapter = new AgyAdapter(path.join(directory, "metadata"), command);
    await adapter.startTurn(thread.id, directory, "What exact word did you write in the previous turn? Reply with only that word. Do not call any tools or read files.", settings, "second");
    await vi.waitFor(async () => expect((await adapter.readSession(thread.id)).turns[1]?.status).toBe("completed"), { timeout: 90_000, interval: 200 });
    const second = (await adapter.readSession(thread.id)).turns[1]!;
    expect(second.items.some((i) => i.type === "agentMessage" && i.text.includes(token))).toBe(true);
    expect(second.items.some((i) => i.type === "genericToolCall")).toBe(false);
    const active = await adapter.startTurn(thread.id, directory, "List integers 1 to 100000, one per line. Do not call tools.", settings, "third");
    // Wait for the native init event to be persisted before testing cancellation.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await adapter.interruptTurn(thread.id, active.turn.id);
    expect((await adapter.readSession(thread.id)).turns[2]?.status).toBe("interrupted");
  } finally { await adapter.stop(); await rm(directory, { recursive: true, force: true }); }
}, 200_000);
