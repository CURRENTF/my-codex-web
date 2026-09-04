import { describe, expect, it } from "vitest";
import { advanceQueuedTurnBarrier, isQueuedTimelineSettled, type QueuedTurnBarrier } from "../../apps/web/src/queued-turn-barrier";

const barrier: QueuedTurnBarrier = { clientRequestId: "request-1", previousLatestTurnId: "turn-previous" };

describe("queued Turn barrier", () => {
  it("waits for the active Turn to reach a terminal Timeline snapshot before dispatching boundary commands", () => {
    expect(isQueuedTimelineSettled("turn-active", { latestTurnId: "turn-previous", latestTurnStatus: "completed" })).toBe(false);
    expect(isQueuedTimelineSettled("turn-active", { latestTurnId: "turn-active", latestTurnStatus: "inProgress" })).toBe(false);
    expect(isQueuedTimelineSettled("turn-active", { latestTurnId: "turn-active", latestTurnStatus: "completed" })).toBe(true);
  });

  it("allows an idle empty Timeline but not an untracked in-progress Turn", () => {
    expect(isQueuedTimelineSettled(null, { latestTurnId: null, latestTurnStatus: null })).toBe(true);
    expect(isQueuedTimelineSettled(null, { latestTurnId: "turn-active", latestTurnStatus: "inProgress" })).toBe(false);
  });

  it("captures a newly observed active Turn and waits for its terminal Timeline state", () => {
    const running = advanceQueuedTurnBarrier(barrier, {
      runtimeState: "running", activeTurnId: "turn-queued", latestTurnId: "turn-queued", latestTurnStatus: "inProgress",
    });
    expect(running).toEqual({ ...barrier, turnId: "turn-queued" });
    expect(advanceQueuedTurnBarrier(running!, {
      runtimeState: "justFinished", latestTurnId: "turn-queued", latestTurnStatus: "completed",
    })).toBeNull();
  });

  it("releases a known queued Turn that completed before running was rendered", () => {
    expect(advanceQueuedTurnBarrier({ ...barrier, turnId: "turn-fast" }, {
      runtimeState: "justFinished", latestTurnId: "turn-fast", latestTurnStatus: "completed",
    })).toBeNull();
  });

  it("waits when the HTTP response arrives before the Turn events", () => {
    expect(advanceQueuedTurnBarrier({ ...barrier, turnId: "turn-delayed" }, {
      runtimeState: "idle", latestTurnId: "turn-previous", latestTurnStatus: "completed",
    })).toEqual({ ...barrier, turnId: "turn-delayed" });
  });

  it("does not treat a temporarily empty Timeline as terminal", () => {
    expect(advanceQueuedTurnBarrier({ ...barrier, turnId: "turn-delayed" }, {
      runtimeState: "idle", latestTurnId: null, latestTurnStatus: null,
    })).toEqual({ ...barrier, turnId: "turn-delayed" });
  });

  it("discovers an unkeyed compact Turn from Timeline events", () => {
    expect(advanceQueuedTurnBarrier(barrier, {
      runtimeState: "justFinished", latestTurnId: "turn-compact", latestTurnStatus: "completed",
    })).toBeNull();
  });

  it("drops the local barrier while disconnected so snapshot recovery can govern the queue", () => {
    expect(advanceQueuedTurnBarrier(barrier, {
      runtimeState: "disconnected", latestTurnId: "turn-previous", latestTurnStatus: "completed",
    })).toBeNull();
  });
});
