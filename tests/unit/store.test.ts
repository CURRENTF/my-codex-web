import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../apps/web/src/store";

beforeEach(() => useAppStore.setState({
  connectionState: "connecting",
  lastEventSeq: 0,
  runtimes: {},
  sideChats: {},
  subagents: {},
  deltas: {},
  pendingRequests: {},
  drafts: {},
  pendingSubmissions: {},
  optimisticUserMessages: {},
  injectedPrefills: {},
  queuedSubmissions: {},
  queuedEffectiveSettings: {},
  queuedTurnBarriers: {},
}));

describe("optimistic user-message lifecycle", () => {
  it("keeps an accepted submission as a fallback until the rendered timeline reconciles it", () => {
    const store = useAppStore.getState();
    store.setDraft("thread-1", "follow up");
    store.beginSubmission("thread-1", "follow up", "message-1");

    expect(useAppStore.getState().optimisticUserMessages["thread-1"]).toEqual([
      { clientUserMessageId: "message-1", text: "follow up", state: "sending" },
    ]);

    store.acceptSubmission("thread-1");
    expect(useAppStore.getState().drafts["thread-1"]).toBeUndefined();
    expect(useAppStore.getState().pendingSubmissions["thread-1"]).toBeUndefined();
    expect(useAppStore.getState().optimisticUserMessages["thread-1"]?.[0]?.state).toBe("queued");

    useAppStore.getState().consume({
      seq: 1,
      type: "item.upserted",
      threadId: "thread-1",
      emittedAt: 1,
      payload: { turnId: "turn-1", item: { id: "user-1", type: "userMessage", clientId: "message-1", content: [{ type: "text", text: "follow up" }] } },
    });

    expect(useAppStore.getState().optimisticUserMessages["thread-1"]?.[0]).toMatchObject({
      clientUserMessageId: "message-1",
      text: "follow up",
      state: "queued",
    });

    useAppStore.getState().reconcileOptimisticUserMessages("thread-1", ["message-1"]);
    expect(useAppStore.getState().optimisticUserMessages["thread-1"]).toBeUndefined();
  });

  it("preserves multiple accepted messages and reconciles only the confirmed client ID", () => {
    const store = useAppStore.getState();
    store.beginSubmission("thread-1", "first", "message-1");
    store.acceptSubmission("thread-1");
    store.beginSubmission("thread-1", "second", "message-2");
    store.acceptSubmission("thread-1");

    expect(useAppStore.getState().optimisticUserMessages["thread-1"]?.map((message) => message.clientUserMessageId)).toEqual(["message-1", "message-2"]);
    useAppStore.getState().reconcileOptimisticUserMessages("thread-1", ["message-1"]);
    expect(useAppStore.getState().optimisticUserMessages["thread-1"]?.map((message) => message.clientUserMessageId)).toEqual(["message-2"]);
  });

  it("removes a failed optimistic message while preserving its draft", () => {
    const store = useAppStore.getState();
    store.setDraft("thread-1", "try again");
    store.beginSubmission("thread-1", "try again", "message-1");
    store.finishSubmission("thread-1", false);

    expect(useAppStore.getState().drafts["thread-1"]).toBe("try again");
    expect(useAppStore.getState().optimisticUserMessages["thread-1"]).toBeUndefined();
  });
});

describe("queued submission lifecycle", () => {
  const message = {
    kind: "message" as const,
    text: "do this next",
    skillNames: ["diagnose"],
    model: "gpt-5.6-sol",
    reasoning: "high",
    serviceTier: "priority",
    accessMode: "fullAccess" as const,
    clientRequestId: "request-next",
    clientUserMessageId: "message-next",
    createdAt: 456,
  };

  it("keeps multiple commands and requirements in FIFO order", () => {
    const command = { kind: "command" as const, raw: "/compact", clientRequestId: "request-compact", createdAt: 123 };
    const laterCommand = { kind: "command" as const, raw: "/status", clientRequestId: "request-status", createdAt: 789 };

    useAppStore.getState().enqueueSubmission("thread-1", command);
    useAppStore.getState().enqueueSubmission("thread-1", message);
    useAppStore.getState().enqueueSubmission("thread-1", laterCommand);

    expect(useAppStore.getState().queuedSubmissions["thread-1"]).toEqual([command, message, laterCommand]);
    expect(useAppStore.getState().optimisticUserMessages["thread-1"]).toEqual([
      { clientUserMessageId: "message-next", text: "do this next", state: "queued" },
    ]);
  });

  it("removes only the selected queue item and its optimistic requirement", () => {
    const first = {
      ...message,
      text: "first",
      clientRequestId: "request-first",
      clientUserMessageId: "message-first",
    };
    const second = {
      ...message,
      text: "second",
      clientRequestId: "request-second",
      clientUserMessageId: "message-second",
    };
    useAppStore.getState().enqueueSubmission("thread-1", first);
    useAppStore.getState().enqueueSubmission("thread-1", second);

    useAppStore.getState().removeQueuedSubmission("thread-1", "different-request");
    expect(useAppStore.getState().queuedSubmissions["thread-1"]).toEqual([first, second]);

    useAppStore.getState().removeQueuedSubmission("thread-1", "request-first");
    expect(useAppStore.getState().queuedSubmissions["thread-1"]).toEqual([second]);
    expect(useAppStore.getState().optimisticUserMessages["thread-1"]).toEqual([
      { clientUserMessageId: "message-second", text: "second", state: "queued" },
    ]);
  });

  it("keeps the optimistic bubble after handing a queued requirement to the App Server", () => {
    useAppStore.getState().enqueueSubmission("thread-1", message);
    useAppStore.getState().removeQueuedSubmission("thread-1", "request-next", true);

    expect(useAppStore.getState().queuedSubmissions["thread-1"]).toBeUndefined();
    expect(useAppStore.getState().optimisticUserMessages["thread-1"]?.[0]?.state).toBe("queued");
  });

  it("returns a failed head requirement to queued state without moving it behind later items", () => {
    const later = {
      ...message,
      text: "later",
      clientRequestId: "request-later",
      clientUserMessageId: "message-later",
      createdAt: 789,
    };
    useAppStore.getState().enqueueSubmission("thread-1", message);
    useAppStore.getState().enqueueSubmission("thread-1", later);
    useAppStore.getState().beginSubmission("thread-1", message.text, message.clientUserMessageId);
    useAppStore.getState().finishSubmission("thread-1", false, true);
    useAppStore.getState().enqueueSubmission("thread-1", message);

    expect(useAppStore.getState().queuedSubmissions["thread-1"]?.map((item) => item.clientRequestId)).toEqual(["request-next", "request-later"]);
    expect(useAppStore.getState().optimisticUserMessages["thread-1"]?.map((item) => [item.clientUserMessageId, item.state])).toEqual([
      ["message-next", "queued"],
      ["message-later", "queued"],
    ]);
  });

  it("applies successful configuration commands to every later queued requirement", () => {
    const command = { kind: "command" as const, raw: "/model gpt-next", clientRequestId: "request-model", createdAt: 1 };
    useAppStore.getState().enqueueSubmission("thread-1", command);
    useAppStore.getState().enqueueSubmission("thread-1", message);

    useAppStore.getState().applyQueuedSettings("thread-1", {
      model: "gpt-next",
      reasoning: "xhigh",
      serviceTier: null,
      accessMode: "readOnly",
    });
    useAppStore.getState().removeQueuedSubmission("thread-1", command.clientRequestId);

    expect(useAppStore.getState().queuedSubmissions["thread-1"]).toEqual([{
      ...message,
      model: "gpt-next",
      reasoning: "xhigh",
      serviceTier: null,
      accessMode: "readOnly",
    }]);
    expect(useAppStore.getState().queuedEffectiveSettings["thread-1"]).toEqual({
      model: "gpt-next",
      reasoning: "xhigh",
      serviceTier: null,
      accessMode: "readOnly",
    });

    useAppStore.getState().removeQueuedSubmission("thread-1", message.clientRequestId);
    expect(useAppStore.getState().queuedEffectiveSettings["thread-1"]).toBeUndefined();
  });

  it("keeps a fork destination isolated from its parent's queue", () => {
    useAppStore.getState().enqueueSubmission("parent-thread", { kind: "command", raw: "/fork", clientRequestId: "request-fork", createdAt: 1 });
    useAppStore.getState().enqueueSubmission("parent-thread", message);

    expect(useAppStore.getState().queuedSubmissions["forked-thread"]).toBeUndefined();
    expect(useAppStore.getState().optimisticUserMessages["forked-thread"]).toBeUndefined();
    expect(useAppStore.getState().queuedSubmissions["parent-thread"]).toHaveLength(2);
  });

  it("keeps a Turn barrier while later items remain and clears it with the final item", () => {
    const later = { ...message, clientRequestId: "request-later", clientUserMessageId: "message-later" };
    useAppStore.getState().enqueueSubmission("thread-1", message);
    useAppStore.getState().enqueueSubmission("thread-1", later);
    useAppStore.getState().setQueuedTurnBarrier("thread-1", { clientRequestId: message.clientRequestId, previousLatestTurnId: "turn-base", turnId: "turn-running" });

    useAppStore.getState().removeQueuedSubmission("thread-1", message.clientRequestId, true);
    expect(useAppStore.getState().queuedTurnBarriers["thread-1"]?.turnId).toBe("turn-running");

    useAppStore.getState().removeQueuedSubmission("thread-1", later.clientRequestId, true);
    expect(useAppStore.getState().queuedTurnBarriers["thread-1"]).toBeUndefined();
  });
});

describe("queued user-message payload", () => {
  it("preserves next-Turn settings and renders it optimistically as queued", () => {
    const message = {
      kind: "message" as const,
      text: "do this next",
      skillNames: ["diagnose"],
      model: "gpt-5.6-sol",
      reasoning: "high",
      serviceTier: "priority",
      accessMode: "fullAccess" as const,
      clientRequestId: "request-next",
      clientUserMessageId: "message-next",
      createdAt: 456,
    };

    useAppStore.getState().enqueueSubmission("thread-1", message);

    expect(useAppStore.getState().queuedSubmissions["thread-1"]).toEqual([message]);
    expect(useAppStore.getState().optimisticUserMessages["thread-1"]).toEqual([
      { clientUserMessageId: "message-next", text: "do this next", state: "queued" },
    ]);
  });

});

describe("live delta lifecycle", () => {
  it("clears a completed Item delta even when completedAtMs is absent", () => {
    useAppStore.getState().consume({ seq: 1, type: "item.delta", threadId: "thread-1", emittedAt: 1, payload: { itemId: "agent-1", delta: "hello" } });
    expect(useAppStore.getState().deltas["agent-1"]).toBe("hello");

    useAppStore.getState().consume({ seq: 2, type: "item.upserted", threadId: "thread-1", emittedAt: 2, payload: { turnId: "turn-1", completed: true, item: { id: "agent-1", type: "agentMessage", text: "hello" } } });

    expect(useAppStore.getState().deltas["agent-1"]).toBeUndefined();
  });

  it("ignores an event sequence that was already applied", () => {
    const event = { seq: 7, type: "item.delta", threadId: "thread-1", emittedAt: 1, payload: { itemId: "agent-1", delta: "hello" } } as const;
    useAppStore.getState().consume(event);
    useAppStore.getState().consume(event);

    expect(useAppStore.getState().deltas["agent-1"]).toBe("hello");
    expect(useAppStore.getState().lastEventSeq).toBe(7);
  });

  it("marks visible Runtime snapshots disconnected when the browser event socket closes", () => {
    useAppStore.getState().initialize([{
      threadId: "thread-1", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [],
    }], [], {}, []);

    useAppStore.getState().markDisconnected();

    expect(useAppStore.getState().runtimes["thread-1"]).toMatchObject({ state: "disconnected" });
    expect(useAppStore.getState().runtimes["thread-1"]?.activeTurnId).toBeUndefined();
  });

  it("hydrates Subagents, applies live updates, and marks them disconnected with the socket", () => {
    const child = {
      threadId: "child", parentThreadId: "parent", forkedFromId: "parent", contextMode: "forked" as const, sourceKind: "threadSpawn" as const,
      depth: 0, agentPath: "review", agentNickname: "reviewer", agentRole: "reviewer", createdAt: 1,
      requestedModel: "gpt-5.6-sol", requestedReasoning: "high", model: null, reasoning: null, prompt: "Review it",
      state: "running" as const, activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [],
    };
    useAppStore.getState().initialize([], [], {}, [], "connected", 7, {}, [child]);
    expect(useAppStore.getState().subagents.child).toEqual(child);

    useAppStore.getState().consume({
      seq: 8, type: "subagent.changed", threadId: "parent", emittedAt: 8,
      payload: { ...child, reasoning: "xhigh" },
    });
    expect(useAppStore.getState().subagents.child?.reasoning).toBe("xhigh");

    useAppStore.getState().markDisconnected();
    expect(useAppStore.getState().subagents.child).toMatchObject({ state: "disconnected" });
    expect(useAppStore.getState().subagents.child?.activeTurnId).toBeUndefined();
  });

  it("preserves terminal Subagent history when the browser socket disconnects", () => {
    const completed = {
      threadId: "completed", parentThreadId: "parent", forkedFromId: "parent", contextMode: "forked" as const, sourceKind: "threadSpawn" as const,
      depth: 0, agentPath: null, agentNickname: null, agentRole: null, createdAt: 1,
      requestedModel: null, requestedReasoning: null, model: "gpt-5.6-sol", reasoning: "high", prompt: null,
      state: "idle" as const, activeFlags: [], pendingRequestIds: [], agentStatus: "completed" as const,
    };
    useAppStore.getState().initialize([], [], {}, [], "connected", 7, {}, [completed]);

    useAppStore.getState().markDisconnected();

    expect(useAppStore.getState().subagents.completed).toEqual(completed);
  });

  it("keeps a global disconnect override for Sessions without Runtime entries until bootstrap recovery", () => {
    useAppStore.getState().initialize([], [], {}, [], "connected");
    useAppStore.getState().markDisconnected();
    expect(useAppStore.getState().connectionState).toBe("disconnected");

    useAppStore.getState().consume({ seq: 3, type: "connection.changed", emittedAt: 3, payload: { state: "connecting" } });
    expect(useAppStore.getState().connectionState).toBe("connecting");

    useAppStore.getState().initialize([], [], {}, [], "connected");
    expect(useAppStore.getState().connectionState).toBe("connected");
  });

  it("restores recovered Fork prefills from bootstrap without overwriting an edited draft", () => {
    useAppStore.getState().initialize([], [], {}, [], "connected", 7, {
      "fork-empty": "original question",
    });
    expect(useAppStore.getState().drafts["fork-empty"]).toBe("original question");

    useAppStore.getState().setDraft("fork-empty", "edited question");
    useAppStore.getState().initialize([], [], {}, [], "connected", 8, {
      "fork-empty": "original question",
    });

    expect(useAppStore.getState().drafts["fork-empty"]).toBe("edited question");
  });

  it("clears an unchanged recovered Fork prefill when another tab starts a Turn", () => {
    useAppStore.getState().initialize([], [], {}, [], "connected", 7, {
      "fork-empty": "original question",
    });

    useAppStore.getState().consume({
      seq: 8,
      type: "turn.started",
      threadId: "fork-empty",
      emittedAt: 8,
      payload: { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 8, completedAt: null, durationMs: null } },
    });

    expect(useAppStore.getState().drafts["fork-empty"]).toBeUndefined();
  });

  it("clears only the submitted draft when a response-lost Turn is later proven applied", () => {
    const store = useAppStore.getState();
    store.setDraft("thread-1", "run the task");
    store.beginSubmission("thread-1", "run the task", "message-1");
    store.markSubmissionUncertain("thread-1");

    store.consume({
      seq: 8,
      type: "uncertainTurn.applied",
      threadId: "thread-1",
      emittedAt: 8,
      payload: { threadId: "thread-1" },
    });

    expect(useAppStore.getState().drafts["thread-1"]).toBeUndefined();
    expect(useAppStore.getState().pendingSubmissions["thread-1"]).toBeUndefined();
  });

  it("does not clear an edited draft when an older response-lost Turn is proven applied", () => {
    const store = useAppStore.getState();
    store.setDraft("thread-1", "run the task");
    store.beginSubmission("thread-1", "run the task", "message-1");
    store.markSubmissionUncertain("thread-1");
    store.setDraft("thread-1", "a different follow-up");

    expect(useAppStore.getState().pendingSubmissions["thread-1"]).toMatchObject({
      draft: "run the task",
      clientUserMessageId: "message-1",
      state: "uncertain",
    });

    store.consume({
      seq: 8,
      type: "uncertainTurn.applied",
      threadId: "thread-1",
      emittedAt: 8,
      payload: { threadId: "thread-1" },
    });

    expect(useAppStore.getState().drafts["thread-1"]).toBe("a different follow-up");
    expect(useAppStore.getState().pendingSubmissions["thread-1"]).toBeUndefined();
  });

  it("preserves an in-flight Steer draft when another tab starts an unrelated Turn", () => {
    const store = useAppStore.getState();
    store.setDraft("thread-1", "keep this steer");
    store.beginSubmission("thread-1", "keep this steer", "steer-message-1");

    store.consume({
      seq: 8,
      type: "turn.started",
      threadId: "thread-1",
      emittedAt: 8,
      payload: { turn: { id: "other-tab-turn", status: "inProgress", items: [], startedAt: 8, completedAt: null, durationMs: null } },
    });

    expect(useAppStore.getState().drafts["thread-1"]).toBe("keep this steer");
    expect(useAppStore.getState().pendingSubmissions["thread-1"]).toMatchObject({
      draft: "keep this steer",
      clientUserMessageId: "steer-message-1",
      state: "sending",
    });

    store.finishSubmission("thread-1", false);
    expect(useAppStore.getState().drafts["thread-1"]).toBe("keep this steer");
    expect(useAppStore.getState().pendingSubmissions["thread-1"]).toBeUndefined();
  });

  it("preserves an edited recovered Fork draft when another tab starts a Turn", () => {
    useAppStore.getState().initialize([], [], {}, [], "connected", 7, {
      "fork-empty": "original question",
    });
    useAppStore.getState().setDraft("fork-empty", "edited follow-up");

    useAppStore.getState().consume({
      seq: 8,
      type: "turn.started",
      threadId: "fork-empty",
      emittedAt: 8,
      payload: { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 8, completedAt: null, durationMs: null } },
    });

    expect(useAppStore.getState().drafts["fork-empty"]).toBe("edited follow-up");
  });

  it("does not restore a recovered Fork prefill after the user intentionally clears it", () => {
    useAppStore.getState().initialize([], [], {}, [], "connected", 7, {
      "fork-empty": "original question",
    });
    useAppStore.getState().setDraft("fork-empty", "");

    useAppStore.getState().initialize([], [], {}, [], "connected", 8, {
      "fork-empty": "original question",
    });

    expect(useAppStore.getState().drafts["fork-empty"]).toBe("");
  });

  it("clears an unchanged recovered Fork prefill when reconnect bootstrap proves it was accepted", () => {
    useAppStore.getState().initialize([], [], {}, [], "connected", 7, {
      "fork-empty": "original question",
    });

    useAppStore.getState().initialize([], [], {}, [], "connected", 8, {});

    expect(useAppStore.getState().drafts["fork-empty"]).toBeUndefined();
  });
});
