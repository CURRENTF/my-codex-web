import { describe, expect, it } from "vitest";
import { sessionSyncResponse } from "../../apps/server/src/session-sync.js";

const turn = (id: string, text = id, status = "completed") => ({ id, status, items: [{ text }] });
describe("session prefix synchronization", () => {
  it("omits unchanged history and still refreshes metadata", () => {
    const payload = { thread: { turns: [turn("a"), turn("b")] }, goal: null };
    const first = sessionSyncResponse(payload);
    const next = sessionSyncResponse({ ...payload, goal: "new" }, first.sync.prefixCount, first.sync.prefixHash);
    expect(next.thread.turns).toEqual([]);
    expect(next.goal).toBe("new");
    expect(next.sync.retainedCount).toBe(2);
  });
  it("resends the active turn and newly appended turns", () => {
    const initial = sessionSyncResponse({ thread: { turns: [turn("a"), turn("b", "partial", "inProgress")] } });
    expect(initial.sync.prefixCount).toBe(1);
    const next = sessionSyncResponse({ thread: { turns: [turn("a"), turn("b", "done"), turn("c")] } }, initial.sync.prefixCount, initial.sync.prefixHash);
    expect(next.thread.turns.map((value) => value.id)).toEqual(["b", "c"]);
  });
  it.each(["edit", "truncate", "reorder"])("falls back to full history on %s", (change) => {
    const initial = sessionSyncResponse({ thread: { turns: [turn("a"), turn("b")] } });
    const turns = change === "edit" ? [turn("a", "changed"), turn("b")] : change === "truncate" ? [turn("a")] : [turn("b"), turn("a")];
    const next = sessionSyncResponse({ thread: { turns } }, initial.sync.prefixCount, initial.sync.prefixHash);
    expect(next.sync.retainedCount).toBe(0);
    expect(next.thread.turns).toEqual(turns);
  });
  it("handles empty histories and unrecognized hashes", () => {
    expect(sessionSyncResponse({ thread: { turns: [] } }, 9, "bad").sync.retainedCount).toBe(0);
    expect(sessionSyncResponse({ thread: { turns: [turn("a")] } }, 1, "bad").thread.turns).toHaveLength(1);
  });
});
