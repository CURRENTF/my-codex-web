import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../apps/web/src/store";

beforeEach(() => useAppStore.setState({
  connectionState: "connecting",
  lastEventSeq: 0,
  runtimes: {},
  sideChats: {},
  deltas: {},
  pendingRequests: {},
  drafts: {},
  pendingSubmissions: {},
  optimisticUserMessages: {},
  injectedPrefills: {},
}));

describe("optimistic user-message lifecycle", () => {
  it("keeps an accepted submission visible as queued until Codex materializes its client ID", () => {
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
