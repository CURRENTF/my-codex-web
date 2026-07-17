import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../apps/web/src/store";

beforeEach(() => useAppStore.getState().initialize([], [], {}, []));

describe("live delta lifecycle", () => {
  it("clears a completed Item delta even when completedAtMs is absent", () => {
    useAppStore.getState().consume({ seq: 1, type: "item.delta", threadId: "thread-1", emittedAt: 1, payload: { itemId: "agent-1", delta: "hello" } });
    expect(useAppStore.getState().deltas["agent-1"]).toBe("hello");

    useAppStore.getState().consume({ seq: 2, type: "item.upserted", threadId: "thread-1", emittedAt: 2, payload: { turnId: "turn-1", completed: true, item: { id: "agent-1", type: "agentMessage", text: "hello" } } });

    expect(useAppStore.getState().deltas["agent-1"]).toBeUndefined();
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
});
