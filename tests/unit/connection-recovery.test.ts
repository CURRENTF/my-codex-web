import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionRecovery } from "../../apps/server/src/connection-recovery";

afterEach(() => vi.useRealTimers());

describe("ConnectionRecovery", () => {
  it("moves to disconnected and retries after reconciliation fails", async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error("temporary snapshot failure"))
      .mockResolvedValueOnce(undefined);
    const recovery = new ConnectionRecovery({
      reconcile,
      onState: (state) => states.push(state),
      onError: vi.fn(),
      retryBaseMs: 10,
      retryMaxMs: 10,
    });

    await recovery.handle("connected");
    expect(states).toEqual(["connecting", "disconnected"]);

    await vi.advanceTimersByTimeAsync(10);
    await recovery.waitForCurrent();

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(states).toEqual(["connecting", "disconnected", "connecting", "connected"]);
    recovery.stop();
  });

  it("cancels a queued retry when the App Server disconnects", async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn().mockRejectedValue(new Error("snapshot failure"));
    const recovery = new ConnectionRecovery({
      reconcile,
      onState: vi.fn(),
      onError: vi.fn(),
      retryBaseMs: 10,
    });

    await recovery.handle("connected");
    await recovery.handle("disconnected");
    await vi.advanceTimersByTimeAsync(20);

    expect(reconcile).toHaveBeenCalledTimes(1);
    recovery.stop();
  });
});
