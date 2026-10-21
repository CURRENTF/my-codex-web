import { describe, expect, it } from "vitest";
import type { RuntimeState, SessionSummary } from "@codex-web/shared-types";
import { sortSidebarSessions } from "../../apps/web/src/sidebar-session-order";

function session(threadId: string, createdAt: number, updatedAt: number, runtimeState: RuntimeState = "idle", pinned = false): SessionSummary {
  return {
    threadId, projectId: "project-1", title: threadId, preview: "", cwd: "/tmp/project", sourceKind: "appServer",
    createdAt, updatedAt, origin: "created", parentThreadId: null, forkTurnId: null, forkSourceTitle: null,
    forkTurnNumber: null, runtimeState, hasGoal: false, pinned,
  };
}
const ids = (sessions: SessionSummary[]) => sessions.map(({ threadId }) => threadId);

describe("Sidebar Session order", () => {
  it("keeps active sessions in the same order through activity updates, refetches, and sort-direction changes", () => {
    const first = session("first", 10, 30, "running");
    const second = session("second", 20, 40, "running");
    const idle = session("idle", 30, 100);
    expect(ids(sortSidebarSessions([idle, second, first], {}, "desc"))).toEqual(["second", "first", "idle"]);
    const updatedFirst = { ...first, updatedAt: 200 };
    const updatedSecond = { ...second, updatedAt: 150 };
    expect(ids(sortSidebarSessions([updatedFirst, updatedSecond, idle], {}, "desc"))).toEqual(["second", "first", "idle"]);
    expect(ids(sortSidebarSessions([updatedSecond, idle, updatedFirst], {}, "asc"))).toEqual(["second", "first", "idle"]);
    expect(updatedFirst.updatedAt).toBe(200);
  });

  it("preserves manual pin priority, including stable active order among pinned sessions", () => {
    const sessions = [session("active", 30, 100, "running"), session("pinned-idle", 40, 200, "idle", true),
      session("pinned-old", 10, 300, "running", true), session("pinned-new", 20, 50, "running", true)];
    expect(ids(sortSidebarSessions(sessions, {}, "desc"))).toEqual(["pinned-new", "pinned-old", "pinned-idle", "active"]);
  });

  it("uses live state to promote running and waiting sessions, and restores time ordering after completion", () => {
    const sessions = [session("recent", 30, 100), session("older", 10, 20), session("waiting", 20, 30)];
    expect(ids(sortSidebarSessions(sessions, { older: { state: "running" }, waiting: { state: "waitingForInput" } }, "desc")))
      .toEqual(["waiting", "older", "recent"]);
    expect(ids(sortSidebarSessions(sessions, { older: { state: "justFinished" }, waiting: { state: "justFinished" } }, "desc")))
      .toEqual(["recent", "waiting", "older"]);
    expect(ids(sortSidebarSessions(sessions, {}, "asc"))).toEqual(["older", "waiting", "recent"]);
  });

  it("lets a completed live state override a stale running summary", () => {
    const sessions = [session("completed", 10, 20, "running"), session("recent", 20, 100)];
    expect(ids(sortSidebarSessions(sessions, { completed: { state: "idle" } }, "desc"))).toEqual(["recent", "completed"]);
  });

  it("keeps ties deterministic when the source array changes and never mutates the source", () => {
    const a = session("a", 10, 50, "running");
    const b = session("b", 10, 100, "running");
    const source = [b, a];
    expect(ids(sortSidebarSessions(source, {}, "desc"))).toEqual(["a", "b"]);
    expect(ids(source)).toEqual(["b", "a"]);
    expect(ids(sortSidebarSessions([a, b], {}, "desc"))).toEqual(["a", "b"]);
  });

  it("retains relative active order in search results and each project group", () => {
    const sessions = [session("old", 10, 200, "running"), { ...session("other-project", 30, 50, "running"), projectId: "project-2" }, session("new", 20, 100, "running")];
    const all = sortSidebarSessions(sessions, {}, "desc");
    expect(ids(all.filter((item) => item.projectId === "project-1"))).toEqual(["new", "old"]);
    expect(ids(sortSidebarSessions(sessions.filter((item) => item.projectId === "project-1"), {}, "desc"))).toEqual(["new", "old"]);
  });
});
