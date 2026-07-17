import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../apps/server/src/database.js";
import { EventGateway } from "../../apps/server/src/event-gateway.js";
import { ThreadRuntimeRegistry } from "../../apps/server/src/runtime-registry.js";
import { projectAdapterEvent } from "@codex-web/codex-adapter";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe("sanitized real-protocol fixture replay", () => {
  it("projects intermediate reasoning, command output, final text, and terminal state", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-web-fixture-"));
    const repositories = new Repositories(path.join(directory, "app.db"));
    const events = new EventGateway(() => true);
    cleanups.push(() => { events.close(); repositories.close(); rmSync(directory, { recursive: true, force: true }); });
    const publish = vi.spyOn(events, "publish");
    const registry = new ThreadRuntimeRegistry(events, repositories);
    const fixture = JSON.parse(readFileSync(new URL("./core-turn.events.json", import.meta.url), "utf8")) as Array<{ method: string; params: unknown }>;

    for (const notification of fixture) {
      const event = projectAdapterEvent(notification);
      if (event) registry.handleEvent(event);
    }

    expect(registry.get("thread-fixture")).toMatchObject({ state: "justFinished", lastTerminalStatus: "completed" });
    expect(publish).toHaveBeenCalledWith("item.delta", expect.objectContaining({ kind: "reasoningSummary" }), { threadId: "thread-fixture" });
    expect(publish).toHaveBeenCalledWith("item.upserted", expect.objectContaining({ item: expect.objectContaining({ type: "commandExecution", status: "completed", exitCode: 0 }) }), { threadId: "thread-fixture" });
    expect(publish).toHaveBeenCalledWith("item.delta", expect.objectContaining({ kind: "commandOutput" }), { threadId: "thread-fixture" });
    expect(publish).toHaveBeenCalledWith("item.delta", expect.objectContaining({ kind: "agentMessage" }), { threadId: "thread-fixture" });
  });
});
