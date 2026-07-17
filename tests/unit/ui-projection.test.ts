import { describe, expect, it } from "vitest";
import { projectItemDelta, projectThread, projectThreadItem, projectTurn, projectTurnPlan } from "@codex-web/codex-adapter";

describe("Codex UI projection", () => {
  it("projects protocol command items into the stable shared DTO", () => {
    const item = projectThreadItem({
      type: "commandExecution",
      id: "command-1",
      command: "printf ok",
      cwd: "/tmp/project",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "ok",
      exitCode: 0,
      durationMs: 12,
    });

    expect(item).toEqual({ type: "commandExecution", id: "command-1", command: "printf ok", cwd: "/tmp/project", status: "completed", aggregatedOutput: "ok", exitCode: 0, durationMs: 12 });
  });

  it("drops unknown protocol fields from turn and delta events", () => {
    const turn = projectTurn({ id: "turn-1", status: "inProgress", itemsView: "full", error: null, startedAt: 10, completedAt: null, durationMs: null, items: [
      { type: "agentMessage", id: "agent-1", text: "working", phase: "commentary", memoryCitation: null },
    ] });
    expect(turn).toEqual({ id: "turn-1", status: "inProgress", startedAt: 10, completedAt: null, durationMs: null, items: [{ type: "agentMessage", id: "agent-1", text: "working", phase: "commentary" }] });
    expect(projectItemDelta("item/agentMessage/delta", { threadId: "secret-protocol-field", turnId: "turn-1", itemId: "agent-1", delta: "x" })).toEqual({ itemId: "agent-1", delta: "x", kind: "agentMessage" });
  });

  it("projects stable turn plan updates into a timeline item", () => {
    expect(projectTurnPlan({
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: "Verification plan",
      plan: [
        { step: "Run command", status: "inProgress" },
        { step: "Report result", status: "pending" },
      ],
    })).toEqual({
      type: "plan",
      id: "turn-plan:turn-1",
      text: "Verification plan\n[~] Run command\n[ ] Report result",
    });
  });

  it("projects a complete refresh snapshot without exposing raw protocol fields", () => {
    const projected = projectThread({
      id: "thread-1", sessionId: "session-1", forkedFromId: null, parentThreadId: null, preview: "hello", ephemeral: false,
      modelProvider: "openai", createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: "idle" }, path: "/secret/internal.jsonl",
      cwd: "/tmp/project", cliVersion: "test", source: "appServer", threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null,
      turns: [{ id: "turn-1", status: "completed", itemsView: "full", error: null, startedAt: 1, completedAt: 2, durationMs: 1_000, items: [{ type: "dynamicToolCall", id: "tool-1", tool: "lookup", arguments: {}, status: "completed", contentItems: null, success: true, durationMs: 10 }] }],
    });
    expect(projected).not.toHaveProperty("path");
    expect(projected.turns[0]?.items[0]).toEqual({
      type: "genericToolCall", id: "tool-1", title: "lookup", status: "completed",
      details: JSON.stringify({ arguments: {}, contentItems: null, success: true }, null, 2),
    });
  });

  it("keeps stable intermediate actions visible with a generic fallback", () => {
    expect(projectThreadItem({ type: "sleep", id: "sleep-1", durationMs: 1_500 })).toMatchObject({ type: "genericToolCall", title: "等待 1.5s" });
    expect(projectThreadItem({ type: "contextCompaction", id: "compact-1" })).toMatchObject({ type: "genericToolCall", title: "压缩上下文" });
    expect(projectThreadItem({ type: "enteredReviewMode", id: "review-1", review: "security" })).toMatchObject({ type: "genericToolCall", details: "security" });
  });
});
