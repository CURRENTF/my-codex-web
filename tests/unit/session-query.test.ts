import "fake-indexeddb/auto";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../../apps/web/src/api";
import type { SessionPayload } from "../../apps/web/src/api";
import { sessionSyncResponse } from "../../apps/server/src/session-sync.js";
import { writeSessionHistory } from "../../apps/web/src/session-history-cache";
import { fetchMergedSession } from "../../apps/web/src/session-query";

const turn = (id: string, text = id) => ({ id, status: "completed" as const, items: [{ id: `item-${id}`, type: "agentMessage" as const, text }] });
const payload = (id: string, turns = [turn("a")]) => ({ thread: { id, turns }, goal: null } as SessionPayload);
const clients: QueryClient[] = [];
function client() { const result = new QueryClient(); clients.push(result); return result; }
afterEach(() => { vi.restoreAllMocks(); clients.splice(0).forEach((value) => value.clear()); });

describe("cached session loading", () => {
  it("does not resurrect a retired assistant ID from an active query cache", async () => {
    const queries = client();
    const data = payload("retired");
    data.thread.turns[0]!.status = "inProgress";
    const canonical = { type: "agentMessage" as const, id: "canonical", text: "我先确认仓库位置，查看 README。" };
    data.thread.turns[0]!.items = [canonical];
    const retired = { ...canonical, id: "retired", text: "我先确认仓库位置" };
    queries.setQueryData(["session", "retired"], { ...data, thread: { ...data.thread, turns: [{ ...data.thread.turns[0]!, items: [retired, canonical] }] } });
    vi.spyOn(apiModule, "api").mockResolvedValue(sessionSyncResponse(data));
    expect((await fetchMergedSession(queries, "retired")).thread.turns[0]?.items).toEqual([canonical]);
  });

  it("shows persistent history before a slow network response and sends its token", async () => {
    const data = payload("hydrate");
    const first = sessionSyncResponse(data);
    await writeSessionHistory("hydrate", data, first.sync);
    let complete!: (value: unknown) => void;
    const request = vi.spyOn(apiModule, "api").mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const queries = client();
    const pending = fetchMergedSession(queries, "hydrate");
    await vi.waitFor(() => expect(queries.getQueryData(["session", "hydrate"])).toEqual(data));
    expect(request.mock.calls[0]?.[0]).toContain(`prefixHash=${first.sync.prefixHash}`);
    complete(sessionSyncResponse(data, first.sync.prefixCount, first.sync.prefixHash));
    expect(await pending).toEqual(data);
  });
  it("does not resurrect truncated history from the query cache", async () => {
    const queries = client();
    queries.setQueryData(["session", "truncate"], payload("truncate", [turn("a"), turn("b")]));
    vi.spyOn(apiModule, "api").mockResolvedValue(sessionSyncResponse(payload("truncate")));
    expect((await fetchMergedSession(queries, "truncate")).thread.turns.map((value) => value.id)).toEqual(["a"]);
  });
  it("preserves concurrent live messages without reordering turns", async () => {
    const queries = client();
    const initial = payload("live", [turn("a"), { ...turn("b", "old"), status: "inProgress" } as ReturnType<typeof turn>]);
    queries.setQueryData(["session", "live"], initial);
    let complete!: (value: unknown) => void;
    const request = vi.spyOn(apiModule, "api").mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = fetchMergedSession(queries, "live");
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    queries.setQueryData(["session", "live"], payload("live", [initial.thread.turns[0] as ReturnType<typeof turn>, turn("b", "old and new")]));
    complete(sessionSyncResponse(initial));
    const result = await pending;
    expect(result.thread.turns.map((value) => value.id)).toEqual(["a", "b"]);
    expect(result.thread.turns[1]?.status).toBe("completed");
    expect(result.thread.turns[1]?.items[0]).toMatchObject({ text: "old and new" });
  });
  it("does not regress a terminal event already received before the request", async () => {
    const queries = client();
    queries.setQueryData(["session", "terminal"], payload("terminal", [turn("a", "complete output")]));
    const stale = payload("terminal", [turn("a", "complete")]);
    stale.thread.turns[0]!.status = "inProgress";
    vi.spyOn(apiModule, "api").mockResolvedValue(sessionSyncResponse(stale));
    const result = await fetchMergedSession(queries, "terminal");
    expect(result.thread.turns[0]?.status).toBe("completed");
    expect(result.thread.turns[0]?.items[0]).toMatchObject({ text: "complete output" });
  });
  it("keeps the cache on transient failure and supports older servers", async () => {
    const data = payload("offline");
    await writeSessionHistory("offline", data, sessionSyncResponse(data).sync);
    const request = vi.spyOn(apiModule, "api").mockRejectedValue(new Error("offline"));
    const queries = client();
    await expect(fetchMergedSession(queries, "offline")).rejects.toThrow("offline");
    expect(queries.getQueryData(["session", "offline"])).toEqual(data);
    request.mockResolvedValue(data);
    expect(await fetchMergedSession(queries, "offline")).toEqual(data);
  });
});
