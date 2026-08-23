import { describe, expect, it } from "vitest";
import type { UiEvent } from "@codex-web/shared-types";
import type { SessionPayload } from "../../apps/web/src/api";
import { applySessionEvent } from "../../apps/web/src/live-session";

function event(type: string, payload: unknown): UiEvent {
  return { seq: 1, type, threadId: "thread-1", emittedAt: Date.now(), payload };
}

const session: SessionPayload = {
  thread: { id: "thread-1", preview: "test", name: null, cwd: "/tmp", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] },
  goal: null,
  runtime: { threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] },
  settings: { model: null, reasoning: null, accessMode: "fullAccess" },
};

describe("applySessionEvent", () => {
  it("adds live App Server errors to the matching Turn without waiting for a refresh", () => {
    const started = applySessionEvent(session, event("turn.started", { turn: { id: "turn-1", status: "inProgress", errors: [], items: [], startedAt: 10, completedAt: null, durationMs: null } }))!;
    const failed = applySessionEvent(started, event("turn.error", {
      turnId: "turn-1",
      error: {
        message: "Connection reset while streaming",
        code: "responseStreamConnectionFailed",
        httpStatusCode: 503,
        additionalDetails: null,
        willRetry: true,
      },
    }))!;

    expect((failed.thread.turns[0] as unknown as { errors: unknown[] }).errors).toEqual([{
      message: "Connection reset while streaming",
      code: "responseStreamConnectionFailed",
      httpStatusCode: 503,
      additionalDetails: null,
      willRetry: true,
    }]);
  });

  it("keeps retry errors when the terminal Turn snapshot adds the final failure", () => {
    const started = applySessionEvent(session, event("turn.started", { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 10, completedAt: null, durationMs: null } }))!;
    const retrying = applySessionEvent(started, event("turn.error", {
      turnId: "turn-1",
      error: { message: "Stream disconnected", code: "responseStreamDisconnected", httpStatusCode: 502, additionalDetails: null, willRetry: true },
    }))!;
    const failed = applySessionEvent(retrying, event("turn.completed", { turn: {
      id: "turn-1",
      status: "failed",
      errors: [{ message: "Retry attempts exhausted", code: "responseTooManyFailedAttempts", httpStatusCode: 502, additionalDetails: null, willRetry: false }],
      items: [],
      startedAt: 10,
      completedAt: 12,
      durationMs: 2_000,
    } }))!;

    expect(failed.thread.turns[0]?.errors).toEqual([
      { message: "Stream disconnected", code: "responseStreamDisconnected", httpStatusCode: 502, additionalDetails: null, willRetry: true },
      { message: "Retry attempts exhausted", code: "responseTooManyFailedAttempts", httpStatusCode: 502, additionalDetails: null, willRetry: false },
    ]);
  });

  it("builds a live turn from item events and preserves its items when completion omits them", () => {
    const started = applySessionEvent(session, event("turn.started", { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 10, completedAt: null, durationMs: null } }))!;
    const withUser = applySessionEvent(started, event("item.upserted", { turnId: "turn-1", item: { type: "userMessage", id: "user-1", content: [{ type: "text", text: "hello" }] } }))!;
    const withAgent = applySessionEvent(withUser, event("item.upserted", { turnId: "turn-1", item: { type: "agentMessage", id: "agent-1", text: "world" }, completedAtMs: 12_000 }))!;
    const completed = applySessionEvent(withAgent, event("turn.completed", { turn: { id: "turn-1", status: "completed", items: [], startedAt: 10, completedAt: 12, durationMs: 2_000 } }))!;

    expect(completed.thread.turns[0]?.status).toBe("completed");
    expect(completed.thread.turns[0]?.items).toHaveLength(2);
    expect(completed.thread.turns[0]?.items[1]).toMatchObject({ type: "agentMessage", text: "world" });
  });

  it("hands streamed agent text to a sparse completion item before its live delta is cleared", () => {
    const started = applySessionEvent(session, event("turn.started", { turn: {
      id: "turn-1", status: "inProgress", items: [{ type: "agentMessage", id: "agent-1", text: "" }],
      startedAt: 10, completedAt: null, durationMs: null,
    } }))!;
    const completed = applySessionEvent(started, event("item.upserted", {
      turnId: "turn-1",
      completed: true,
      item: { type: "agentMessage", id: "agent-1", text: "" },
    }), { "agent-1": "streamed answer" })!;

    expect(completed.thread.turns[0]?.items[0]).toMatchObject({
      type: "agentMessage",
      text: "streamed answer",
    });
  });

  it("preserves the user-message client ID and restored attachment metadata across sparse live snapshots", () => {
    const withRestoredAttachment: SessionPayload = {
      ...session,
      thread: {
        ...session.thread,
        turns: [{
          id: "turn-1",
          status: "inProgress",
          startedAt: 10,
          completedAt: null,
          durationMs: null,
          items: [{
            type: "userMessage",
            id: "user-1",
            clientId: "message-1",
            content: [
              { type: "text", text: "inspect this" },
              { type: "mention", path: "/server/attachment.txt", name: "attachment.txt", downloadUrl: "/api/attachments/attachment-1/content?download=1" },
            ],
          }],
        }],
      },
    };

    const afterItemEvent = applySessionEvent(withRestoredAttachment, event("item.upserted", {
      turnId: "turn-1",
      item: { type: "userMessage", id: "user-live", clientId: "message-1", content: [{ type: "text", text: "inspect this" }] },
    }))!;
    expect(afterItemEvent.thread.turns[0]?.items[0]).toMatchObject({
      clientId: "message-1",
      content: [
        { type: "text", text: "inspect this" },
        { type: "mention", name: "attachment.txt", downloadUrl: "/api/attachments/attachment-1/content?download=1" },
      ],
    });

    const completed = applySessionEvent(afterItemEvent, event("turn.completed", {
      turn: {
        id: "turn-1",
        status: "completed",
        startedAt: 10,
        completedAt: 12,
        durationMs: 2_000,
        items: [{ type: "userMessage", id: "user-completed", clientId: "message-1", content: [{ type: "text", text: "inspect this" }] }],
      },
    }))!;
    expect(completed.thread.turns[0]?.items[0]).toMatchObject({
      clientId: "message-1",
      content: [
        { type: "text", text: "inspect this" },
        { type: "mention", name: "attachment.txt", downloadUrl: "/api/attachments/attachment-1/content?download=1" },
      ],
    });
  });

  it("updates Goal state without requiring a Session refetch", () => {
    const withGoal = applySessionEvent(session, event("goal.updated", { goal: { threadId: "thread-1", objective: "ship", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } }))!;
    expect(withGoal.goal?.objective).toBe("ship");
    expect(applySessionEvent(withGoal, event("goal.cleared", { threadId: "thread-1" }))?.goal).toBeNull();
  });

  it("retains command output deltas that are absent from the completion item", () => {
    const started = applySessionEvent(session, event("turn.started", { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 10, completedAt: null, durationMs: null } }))!;
    const withCommand = applySessionEvent(started, event("item.upserted", { turnId: "turn-1", item: {
      type: "commandExecution", id: "command-1", command: "run", cwd: "/tmp", status: "inProgress",
      aggregatedOutput: null, exitCode: null, durationMs: null,
    } }))!;
    const withFirstDelta = applySessionEvent(withCommand, event("item.delta", { itemId: "command-1", kind: "commandOutput", delta: "LINE_1\n" }))!;
    const completed = applySessionEvent(withFirstDelta, event("item.upserted", { turnId: "turn-1", completedAtMs: 12_000, item: {
      type: "commandExecution", id: "command-1", command: "run", cwd: "/tmp", status: "completed",
      aggregatedOutput: "LINE_2\nLINE_3\n", exitCode: 0, durationMs: 2_000,
    } }))!;

    expect(completed.thread.turns[0]?.items[0]).toMatchObject({
      type: "commandExecution",
      aggregatedOutput: "LINE_1\nLINE_2\nLINE_3\n",
      exitCode: 0,
    });
  });

  it("hydrates a command completion when its first delta arrived before item start", () => {
    const started = applySessionEvent(session, event("turn.started", { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 10, completedAt: null, durationMs: null } }))!;
    const completed = applySessionEvent(started, event("item.upserted", { turnId: "turn-1", completedAtMs: 12_000, item: {
      type: "commandExecution", id: "command-1", command: "run", cwd: "/tmp", status: "completed",
      aggregatedOutput: "LINE_2\nLINE_3\n", exitCode: 0, durationMs: 2_000,
    } }), { "command-1": "LINE_1\nLINE_2\nLINE_3\n" })!;

    expect(completed.thread.turns[0]?.items[0]).toMatchObject({
      aggregatedOutput: "LINE_1\nLINE_2\nLINE_3\n",
      exitCode: 0,
    });
  });

  it("merges a partial completion snapshot without deleting streamed tool items", () => {
    const started = applySessionEvent(session, event("turn.started", { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 10, completedAt: null, durationMs: null } }))!;
    const withCommand = applySessionEvent(started, event("item.upserted", { turnId: "turn-1", item: { type: "commandExecution", id: "command-1", command: "run", cwd: "/tmp", status: "completed", aggregatedOutput: "ok", exitCode: 0, durationMs: 10 } }))!;
    const completed = applySessionEvent(withCommand, event("turn.completed", { turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", id: "agent-1", text: "done" }], startedAt: 10, completedAt: 12, durationMs: 2_000 } }))!;
    expect(completed.thread.turns[0]?.items.map((item) => item.id)).toEqual(["command-1", "agent-1"]);
  });

  it("preserves streamed command output when the terminal Turn snapshot contains only the last chunk", () => {
    const started = applySessionEvent(session, event("turn.started", { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 10, completedAt: null, durationMs: null } }))!;
    const withCommand = applySessionEvent(started, event("item.upserted", { turnId: "turn-1", item: {
      type: "commandExecution", id: "command-1", command: "run", cwd: "/tmp", status: "inProgress",
      aggregatedOutput: null, exitCode: null, durationMs: null,
    } }))!;
    const withFirstDelta = applySessionEvent(withCommand, event("item.delta", { itemId: "command-1", kind: "commandOutput", delta: "LINE_1\n" }))!;
    const completed = applySessionEvent(withFirstDelta, event("turn.completed", { turn: {
      id: "turn-1", status: "completed", startedAt: 10, completedAt: 12, durationMs: 2_000,
      items: [{
        type: "commandExecution", id: "command-1", command: "run", cwd: "/tmp", status: "completed",
        aggregatedOutput: "LINE_2\n", exitCode: 0, durationMs: 2_000,
      }],
    } }))!;

    expect(completed.thread.turns[0]?.items[0]).toMatchObject({
      type: "commandExecution",
      aggregatedOutput: "LINE_1\nLINE_2\n",
      exitCode: 0,
    });
  });

  it("appends independent command delta chunks literally", () => {
    const started = applySessionEvent(session, event("turn.started", { turn: { id: "turn-1", status: "inProgress", items: [{ type: "commandExecution", id: "command-1", command: "run", cwd: "/tmp", status: "inProgress", aggregatedOutput: "a", exitCode: null, durationMs: null }], startedAt: 10, completedAt: null, durationMs: null } }))!;
    const updated = applySessionEvent(started, event("item.delta", { itemId: "command-1", kind: "commandOutput", delta: "apple" }))!;
    expect(updated.thread.turns[0]?.items[0]).toMatchObject({ aggregatedOutput: "aapple" });
  });

  it("does not leave tool cards in progress after their Turn reaches a terminal state", () => {
    const started = applySessionEvent(session, event("turn.started", { turn: {
      id: "turn-1",
      status: "inProgress",
      items: [{ type: "commandExecution", id: "command-1", command: "sleep 30", cwd: "/tmp", status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null }],
      startedAt: 10,
      completedAt: null,
      durationMs: null,
    } }))!;
    const interrupted = applySessionEvent(started, event("turn.completed", { turn: {
      id: "turn-1",
      status: "interrupted",
      items: [{ type: "commandExecution", id: "command-1", command: "sleep 30", cwd: "/tmp", status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null }],
      startedAt: 10,
      completedAt: 11,
      durationMs: 1_000,
    } }))!;

    expect(interrupted.thread.turns[0]?.items[0]).toMatchObject({ status: "interrupted" });

    const lateInProgress = applySessionEvent(interrupted, event("item.upserted", {
      turnId: "turn-1",
      item: { type: "commandExecution", id: "command-1", command: "sleep 30", cwd: "/tmp", status: "inProgress", aggregatedOutput: "", exitCode: null, durationMs: null },
    }))!;
    expect(lateInProgress.thread.turns[0]?.items[0]).toMatchObject({ status: "interrupted" });
  });

  it("preserves a late natural command result without changing the interrupted Turn", () => {
    const started = applySessionEvent(session, event("turn.started", { turn: {
      id: "turn-1",
      status: "inProgress",
      items: [{ type: "commandExecution", id: "command-1", command: "sleep 45", cwd: "/tmp", status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null }],
      startedAt: 10,
      completedAt: null,
      durationMs: null,
    } }))!;
    const interrupted = applySessionEvent(started, event("turn.completed", { turn: {
      id: "turn-1",
      status: "interrupted",
      items: [],
      startedAt: 10,
      completedAt: 22,
      durationMs: 12_000,
    } }))!;
    const lateCompleted = applySessionEvent(interrupted, event("item.upserted", {
      turnId: "turn-1",
      completedAtMs: 55_000,
      item: { type: "commandExecution", id: "command-1", command: "sleep 45", cwd: "/tmp", status: "completed", aggregatedOutput: "", exitCode: 0, durationMs: 45_000 },
    }))!;

    expect(lateCompleted.thread.turns[0]).toMatchObject({
      status: "interrupted",
    });
    expect(lateCompleted.thread.turns[0]?.items[0]).toMatchObject({
      type: "commandExecution",
      status: "completed",
      exitCode: 0,
      durationMs: 45_000,
    });
  });

  it("terminalizes streamed tool items when an interrupted Turn completion omits items", () => {
    const started = applySessionEvent(session, event("turn.started", { turn: {
      id: "turn-1",
      status: "inProgress",
      items: [],
      startedAt: 10,
      completedAt: null,
      durationMs: null,
    } }))!;
    const withCommand = applySessionEvent(started, event("item.upserted", {
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "sleep 30",
        cwd: "/tmp",
        status: "inProgress",
        aggregatedOutput: "started\n",
        exitCode: null,
        durationMs: null,
      },
    }))!;
    const interrupted = applySessionEvent(withCommand, event("turn.completed", { turn: {
      id: "turn-1",
      status: "interrupted",
      items: [],
      startedAt: 10,
      completedAt: 11,
      durationMs: 1_000,
    } }))!;

    expect(interrupted.thread.turns[0]?.items[0]).toMatchObject({
      type: "commandExecution",
      status: "interrupted",
      aggregatedOutput: "started\n",
    });
  });
});
