import { describe, expect, it, vi } from "vitest";
import { synchronizeLiveSnapshot } from "../../apps/web/src/snapshot-refresh";

describe("synchronizeLiveSnapshot", () => {
  it("resumes buffered events before slow Session refetches finish", async () => {
    let finishRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => { finishRefresh = resolve; });
    const applySnapshotAndResumeEvents = vi.fn(() => true);

    const synchronization = synchronizeLiveSnapshot({
      loadSnapshot: async () => ({ eventSeq: 41 }),
      applySnapshotAndResumeEvents,
      refreshQueries: () => refreshBlocked,
    });
    await vi.waitFor(() => expect(applySnapshotAndResumeEvents).toHaveBeenCalledWith({ eventSeq: 41 }));

    let settled = false;
    void synchronization.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishRefresh();
    await expect(synchronization).resolves.toBe(true);
  });
});
