import { describe, expect, it, vi } from "vitest";
import type { ListedSubagent } from "@codex-web/codex-adapter";
import { restoreSubagentSnapshot } from "../../apps/server/src/subagent-restoration";

function subagent(threadId: string): ListedSubagent {
  return {
    threadId,
    parentThreadId: "parent",
    forkedFromId: null,
    contextMode: "isolated",
    sourceKind: "threadSpawn",
    depth: 0,
    agentPath: `/root/${threadId}`,
    agentNickname: threadId,
    agentRole: "worker",
    createdAt: 1,
    state: "idle",
    activeFlags: [],
    agentStatus: "notLoaded",
  };
}

describe("Subagent restart restoration", () => {
  it("collects every App Server page before hydrating the WebUI runtime snapshot", async () => {
    const listSubagents = vi.fn(async (cursor: string | null = null) => cursor === null
      ? { data: [subagent("child-1")], nextCursor: "page-2" }
      : { data: [subagent("child-2")], nextCursor: null });
    const restoreSubagents = vi.fn();

    await expect(restoreSubagentSnapshot({ listSubagents }, { restoreSubagents }, 1)).resolves.toBe(2);

    expect(listSubagents.mock.calls).toEqual([[null, 1], ["page-2", 1]]);
    expect(restoreSubagents).toHaveBeenCalledOnce();
    expect(restoreSubagents).toHaveBeenCalledWith([
      expect.objectContaining({ threadId: "child-1" }),
      expect.objectContaining({ threadId: "child-2" }),
    ]);
  });

  it("rejects a repeated cursor instead of looping forever", async () => {
    const listSubagents = vi.fn(async () => ({ data: [], nextCursor: "same-page" }));
    await expect(restoreSubagentSnapshot({ listSubagents }, { restoreSubagents: vi.fn() }))
      .rejects.toThrow("repeated Subagent pagination cursor");
  });
});
