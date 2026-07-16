import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../apps/server/src/database";
import { EventGateway } from "../../apps/server/src/event-gateway";
import { ThreadRuntimeRegistry } from "../../apps/server/src/runtime-registry";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) cleanup(); });

describe("runtime projection", () => {
  it("projects turn lifecycle and clears justFinished after 20 seconds", () => {
    vi.useFakeTimers();
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.handleNotification({ method: "turn/started", params: { threadId: "t1", turn: { id: "turn-1" } } });
    expect(registry.get("t1")).toMatchObject({ state: "running", activeTurnId: "turn-1" });
    registry.handleNotification({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } } });
    expect(registry.get("t1").state).toBe("justFinished");
    vi.advanceTimersByTime(20_001);
    expect(registry.get("t1").state).toBe("idle");
  });

  it("marks active sessions disconnected when app-server exits", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("t1", "turn-1"); registry.handleConnection("disconnected");
    expect(registry.get("t1")).toMatchObject({ state: "disconnected" });
    expect(registry.get("t1").activeTurnId).toBeUndefined();
  });
});
