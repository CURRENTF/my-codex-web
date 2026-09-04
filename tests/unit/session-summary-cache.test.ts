import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@codex-web/shared-types";
import {
  applyCachedSessionSummaryEvent,
  patchCachedSessionSummary,
  removeCachedSessionSummary,
  upsertCachedSessionSummary,
} from "../../apps/web/src/session-summary-cache";

function summary(threadId: string, title: string, updatedAt: number): SessionSummary {
  return {
    threadId, projectId: "project-1", title, preview: title, cwd: "/tmp/project", sourceKind: "appServer",
    createdAt: 1, updatedAt, origin: "created", parentThreadId: null, forkTurnId: null,
    forkSourceTitle: null, forkTurnNumber: null, runtimeState: "idle", hasGoal: false, pinned: false,
  };
}

describe("Session summary cache", () => {
  it("inserts a created Session into cached lists immediately and preserves each sort order", () => {
    const client = new QueryClient();
    client.setQueryData(["sessions", "", "desc"], [summary("old", "Old", 10)]);
    client.setQueryData(["sessions", "", "asc"], [summary("old", "Old", 10)]);

    upsertCachedSessionSummary(client, summary("new", "New", 20));

    expect(client.getQueryData<SessionSummary[]>(["sessions", "", "desc"])?.map((item) => item.threadId)).toEqual(["new", "old"]);
    expect(client.getQueryData<SessionSummary[]>(["sessions", "", "asc"])?.map((item) => item.threadId)).toEqual(["old", "new"]);
  });

  it("keeps pinned Sessions ahead of the selected time direction", () => {
    const client = new QueryClient();
    client.setQueryData(["sessions", "", "desc"], [summary("newest", "Newest", 30), summary("older", "Older", 20)]);

    patchCachedSessionSummary(client, "older", { pinned: true });
    expect(client.getQueryData<SessionSummary[]>(["sessions", "", "desc"])?.map((item) => item.threadId)).toEqual(["older", "newest"]);

    applyCachedSessionSummaryEvent(client, "older", { reason: "pin-updated", pinned: false }, "idle", 40);
    expect(client.getQueryData<SessionSummary[]>(["sessions", "", "desc"])?.map((item) => item.threadId)).toEqual(["newest", "older"]);
  });

  it("updates rename/search caches and removes an archived Session without a refetch", () => {
    const client = new QueryClient();
    const initial = { ...summary("thread-1", "Before", 10), preview: "body" };
    client.setQueryData(["sessions", "", "desc"], [initial]);
    client.setQueryData(["sessions", "after", "desc"], []);
    client.setQueryData(["sessions", "before", "desc"], [initial]);

    patchCachedSessionSummary(client, "thread-1", { title: "After", updatedAt: 20 });

    expect(client.getQueryData<SessionSummary[]>(["sessions", "", "desc"])?.[0]?.title).toBe("After");
    expect(client.getQueryData<SessionSummary[]>(["sessions", "before", "desc"])).toEqual([]);
    expect(client.getQueryData<SessionSummary[]>(["sessions", "after", "desc"])?.map((item) => item.threadId)).toEqual(["thread-1"]);
    removeCachedSessionSummary(client, "thread-1");
    expect(client.getQueryData<SessionSummary[]>(["sessions", "", "desc"])).toEqual([]);
  });

  it("applies routine WebSocket summary events incrementally", () => {
    const client = new QueryClient();
    client.setQueryData(["sessions", "", "desc"], [summary("thread-1", "Before", 10)]);

    applyCachedSessionSummaryEvent(client, "thread-1", { reason: "renamed", name: "After" }, "idle", 20);
    applyCachedSessionSummaryEvent(client, "thread-1", { reason: "goal-updated" }, "idle", 21);
    applyCachedSessionSummaryEvent(client, "thread-1", { reason: "turn-started" }, "running", 22);

    expect(client.getQueryData<SessionSummary[]>(["sessions", "", "desc"])?.[0]).toMatchObject({
      title: "After", hasGoal: true, runtimeState: "running", updatedAt: 22,
    });
  });
});
