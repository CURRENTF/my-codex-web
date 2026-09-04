import { describe, expect, it } from "vitest";
import type { Project, SessionSummary } from "@codex-web/shared-types";
import { canBranchSession, recentSessionToAutoOpen, sessionCreationProjectId } from "../../apps/web/src/session-selection";

function project(id: string): Project {
  return {
    id, name: id, rootPath: `/tmp/${id}`, canonicalPath: `/tmp/${id}`, orderIndex: 0,
    defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess",
    createdAt: 1, lastOpenedAt: null, available: true,
  };
}

function session(threadId: string, projectId: string): SessionSummary {
  return {
    threadId, projectId, title: threadId, preview: "", cwd: `/tmp/${projectId}`,
    sourceKind: "appServer", createdAt: 1, updatedAt: 1, origin: "created",
    parentThreadId: null, forkTurnId: null, forkSourceTitle: null, forkTurnNumber: null,
    runtimeState: "idle", hasGoal: false, pinned: false,
  };
}

describe("Session selection", () => {
  it("does not reopen a stale Session while its selected Project is being removed", () => {
    expect(recentSessionToAutoOpen(null, [session("stale-thread", "removed-project")], [project("removed-project")], "removed-project", true)).toBeNull();
  });

  it("keeps a newly selected empty Project on the empty state instead of reopening an old Session", () => {
    expect(recentSessionToAutoOpen(null, [session("old-thread", "old-project")], [project("old-project"), project("new-project")], "new-project")).toBeNull();
  });

  it("uses the newly selected Project for the global New Session action", () => {
    expect(sessionCreationProjectId(undefined, undefined, "new-project", [project("old-project"), project("new-project")])).toBe("new-project");
  });

  it("keeps explicit and current Session Project choices ahead of the preference", () => {
    const projects = [project("explicit"), project("current"), project("preferred")];
    expect(sessionCreationProjectId("explicit", "current", "preferred", projects)).toBe("explicit");
    expect(sessionCreationProjectId(undefined, "current", "preferred", projects)).toBe("current");
  });

  it("never selects an unavailable Project for Session creation", () => {
    const missing = { ...project("missing"), available: false };
    const available = project("available");
    expect(sessionCreationProjectId("missing", undefined, undefined, [missing, available])).toBeUndefined();
    expect(sessionCreationProjectId(undefined, "missing", undefined, [missing, available])).toBe("available");
    expect(sessionCreationProjectId(undefined, undefined, "missing", [missing])).toBeUndefined();
  });

  it("disables Fork and Side Chat while the Project is unavailable or the Session is disconnected", () => {
    expect(canBranchSession(true, "idle")).toBe(true);
    expect(canBranchSession(false, "idle")).toBe(false);
    expect(canBranchSession(true, "disconnected")).toBe(false);
  });
});
