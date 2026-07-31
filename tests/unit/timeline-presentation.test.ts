import { describe, expect, it } from "vitest";
import type { SessionItem } from "@codex-web/shared-types";
import { canReconcileOptimisticUserMessages, formatTurnCompletedAt, formatTurnDuration, groupTimelineItems, unconfirmedOptimisticUserMessages } from "../../apps/web/src/timeline-presentation";

describe("Timeline presentation", () => {
  it("formats completed Turn durations as minutes and seconds", () => {
    expect(formatTurnDuration(585_000)).toBe("9分钟45秒");
    expect(formatTurnDuration(60_000)).toBe("1分钟0秒");
    expect(formatTurnDuration(8_400)).toBe("8秒");
    expect(formatTurnDuration(0)).toBe("1秒");
    expect(formatTurnDuration(null)).toBe("");
  });

  it("formats the completion time in the browser's local time", () => {
    const localTime = new Date(2026, 6, 27, 9, 8, 7).getTime() / 1_000;
    expect(formatTurnCompletedAt(localTime)).toBe("2026-07-27 09:08:07");
    expect(formatTurnCompletedAt(null)).toBe("");
  });

  it("merges consecutive reasoning and tool items while preserving message boundaries", () => {
    const items: SessionItem[] = [
      { type: "userMessage", id: "user", content: [{ type: "text", text: "question" }] },
      { type: "reasoning", id: "reasoning-1", summary: ["inspect"] },
      { type: "commandExecution", id: "command-1", command: "pwd", cwd: "/tmp", status: "completed", aggregatedOutput: "/tmp", exitCode: 0, durationMs: 10 },
      { type: "mcpToolCall", id: "mcp-1", server: "test", tool: "read", status: "completed", durationMs: 20 },
      { type: "agentMessage", id: "agent", text: "answer" },
      { type: "genericToolCall", id: "tool-2", title: "follow-up", status: "completed" },
      { type: "plan", id: "plan", text: "next" },
      { type: "fileChange", id: "file-1", status: "completed", changes: [] },
    ];

    const grouped = groupTimelineItems(items);
    expect(grouped.map((entry) => entry.kind)).toEqual(["item", "activity", "item", "activity", "item", "activity"]);
    expect(grouped[1]).toMatchObject({ kind: "activity", items: [
      { id: "reasoning-1" },
      { id: "command-1" },
      { id: "mcp-1" },
    ] });
    expect(grouped[3]).toMatchObject({ kind: "activity", items: [{ id: "tool-2" }] });
    expect(grouped[5]).toMatchObject({ kind: "activity", items: [{ id: "file-1" }] });
  });

  it("hides an optimistic User bubble once the matching client ID is materialized", () => {
    const turns = [{
      id: "turn-1",
      status: "inProgress" as const,
      items: [{ type: "userMessage" as const, id: "user-1", clientId: "message-1", content: [{ type: "text", text: "first" }] }],
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    }];
    const messages = [
      { clientUserMessageId: "message-1", text: "first" },
      { clientUserMessageId: "message-2", text: "second" },
    ];

    expect(unconfirmedOptimisticUserMessages(turns, messages)).toEqual([messages[1]]);
  });

  it("keeps an optimistic fallback during an active Turn so a stale refetch cannot erase a Steer", () => {
    const message = { clientUserMessageId: "steer-1", text: "additional requirement" };
    const liveTurns = [{
      id: "turn-1",
      status: "inProgress" as const,
      items: [{ type: "userMessage" as const, id: "steer-item", clientId: "steer-1", content: [{ type: "text", text: message.text }] }],
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    }];
    const staleRefetchTurns = [{ ...liveTurns[0]!, items: [] }];

    expect(canReconcileOptimisticUserMessages(liveTurns)).toBe(false);
    expect(unconfirmedOptimisticUserMessages(liveTurns, [message])).toEqual([]);
    expect(unconfirmedOptimisticUserMessages(staleRefetchTurns, [message])).toEqual([message]);
    expect(canReconcileOptimisticUserMessages([{ ...liveTurns[0]!, status: "completed", completedAt: 2 }])).toBe(true);
  });
});
