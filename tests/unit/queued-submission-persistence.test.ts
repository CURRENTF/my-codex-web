import { afterEach, describe, expect, it, vi } from "vitest";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

class ThrowingStorage {
  getItem(): never { throw new DOMException("Storage disabled", "SecurityError"); }
  setItem(): never { throw new DOMException("Storage disabled", "SecurityError"); }
  removeItem(): never { throw new DOMException("Storage disabled", "SecurityError"); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("queued submission persistence", () => {
  it("starts with empty queue state when browser storage is unavailable", async () => {
    vi.stubGlobal("window", { localStorage: new ThrowingStorage() });

    const { useAppStore } = await import("../../apps/web/src/store");

    expect(useAppStore.getState().queuedSubmissions).toEqual({});
    expect(useAppStore.getState().queuedEffectiveSettings).toEqual({});
    expect(useAppStore.getState().queuedTurnBarriers).toEqual({});
  });

  it("migrates legacy single-item message and command slots into timestamp order", async () => {
    const localStorage = new MemoryStorage();
    localStorage.setItem("codex-web:queued-slash-commands:v1", JSON.stringify({
      "thread-1": { raw: "/status", clientRequestId: "command-2", createdAt: 20 },
    }));
    localStorage.setItem("codex-web:queued-user-messages:v1", JSON.stringify({
      "thread-1": {
        text: "first", skillNames: [], model: "gpt-5.6-sol", reasoning: "high", serviceTier: null,
        accessMode: "fullAccess", clientRequestId: "message-1", clientUserMessageId: "user-1", createdAt: 10,
      },
    }));
    vi.stubGlobal("window", { localStorage });

    const { useAppStore } = await import("../../apps/web/src/store");

    expect(useAppStore.getState().queuedSubmissions["thread-1"]?.map((submission) => [submission.kind, submission.clientRequestId])).toEqual([
      ["message", "message-1"],
      ["command", "command-2"],
    ]);
    expect(useAppStore.getState().optimisticUserMessages["thread-1"]?.[0]).toMatchObject({ clientUserMessageId: "user-1", state: "queued" });
  });

  it("persists multiple FIFO items in v2 and retires legacy keys on the first change", async () => {
    const localStorage = new MemoryStorage();
    localStorage.setItem("codex-web:queued-slash-commands:v1", "{}");
    vi.stubGlobal("window", { localStorage });
    const { useAppStore } = await import("../../apps/web/src/store");

    useAppStore.getState().enqueueSubmission("thread-1", { kind: "command", raw: "/status", clientRequestId: "one", createdAt: 1 });
    useAppStore.getState().enqueueSubmission("thread-1", { kind: "command", raw: "/compact", clientRequestId: "two", createdAt: 2 });

    expect(JSON.parse(localStorage.getItem("codex-web:queued-submissions:v2") ?? "{}")["thread-1"]).toHaveLength(2);
    expect(localStorage.getItem("codex-web:queued-slash-commands:v1")).toBeNull();
  });

  it("restores effective settings while a parent queue remains across Fork navigation", async () => {
    const localStorage = new MemoryStorage();
    localStorage.setItem("codex-web:queued-submissions:v2", JSON.stringify({
      "parent-thread": [
        { kind: "command", raw: "/fork", clientRequestId: "fork-request", createdAt: 1 },
        { kind: "command", raw: "/reasoning xhigh", clientRequestId: "reasoning-request", createdAt: 2 },
      ],
    }));
    localStorage.setItem("codex-web:queued-effective-settings:v1", JSON.stringify({
      "parent-thread": { model: "gpt-next", reasoning: "high", serviceTier: null, accessMode: "readOnly" },
      "forked-thread": { model: "must-not-leak", reasoning: "low", serviceTier: null, accessMode: "fullAccess" },
    }));
    localStorage.setItem("codex-web:queued-turn-barriers:v1", JSON.stringify({
      "parent-thread": { clientRequestId: "previous-request", previousLatestTurnId: "turn-base", turnId: "turn-running" },
      "forked-thread": { clientRequestId: "must-not-leak", previousLatestTurnId: null },
    }));
    vi.stubGlobal("window", { localStorage });

    const { useAppStore } = await import("../../apps/web/src/store");

    expect(useAppStore.getState().queuedEffectiveSettings).toEqual({
      "parent-thread": { model: "gpt-next", reasoning: "high", serviceTier: null, accessMode: "readOnly" },
    });
    expect(useAppStore.getState().queuedSubmissions["forked-thread"]).toBeUndefined();
    expect(useAppStore.getState().queuedTurnBarriers).toEqual({
      "parent-thread": { clientRequestId: "previous-request", previousLatestTurnId: "turn-base", turnId: "turn-running" },
    });
  });
});
