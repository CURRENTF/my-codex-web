import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../../apps/web/src/api";
import { sessionSyncResponse } from "../../apps/server/src/session-sync.js";

const payload = (id: string, text = "cached"): SessionPayload => ({
  thread: { id, turns: [{ id: "turn-1", status: "completed", items: [{ id: "item-1", type: "agentMessage", text }] }] },
  goal: null,
} as SessionPayload);

beforeEach(() => vi.resetModules());
describe("persistent session history", () => {
  it("restores from IndexedDB after memory is discarded and deletes archived history", async () => {
    let cache = await import("../../apps/web/src/session-history-cache");
    const data = payload("persist");
    const { sync } = sessionSyncResponse(data);
    await cache.writeSessionHistory("persist", data, sync);
    vi.resetModules();
    cache = await import("../../apps/web/src/session-history-cache");
    expect((await cache.readSessionHistory("persist"))?.payload).toEqual(data);
    await cache.removeSessionHistory("persist");
    expect(await cache.readSessionHistory("persist")).toBeUndefined();
  });
  it("reconstructs matching prefixes and replaces mismatched history", async () => {
    const cache = await import("../../apps/web/src/session-history-cache");
    const data = payload("merge");
    const first = sessionSyncResponse(data);
    await cache.writeSessionHistory("merge", data, first.sync);
    const cached = await cache.readSessionHistory("merge");
    const unchanged = sessionSyncResponse(data, first.sync.prefixCount, first.sync.prefixHash);
    expect(cache.reconstructSession(unchanged, cached)).toEqual(data);
    expect(() => cache.reconstructSession(unchanged)).toThrow("prefix");
    const changed = payload("merge", "rewritten");
    expect(cache.reconstructSession(sessionSyncResponse(changed, first.sync.prefixCount, first.sync.prefixHash), cached)).toEqual(changed);
  });
  it("bounds disk entries and expires old history", async () => {
    const cache = await import("../../apps/web/src/session-history-cache");
    for (let index = 0; index < 22; index++) {
      const data = payload(`limit-${index}`);
      await cache.writeSessionHistory(data.thread.id, data, sessionSyncResponse(data).sync);
    }
    vi.resetModules();
    const fresh = await import("../../apps/web/src/session-history-cache");
    expect(await fresh.readSessionHistory("limit-0")).toBeUndefined();
    expect(await fresh.readSessionHistory("limit-21")).toBeDefined();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(await fresh.readSessionHistory("limit-21")).toBeUndefined();
    now.mockRestore();
  });
});
