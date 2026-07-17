import { describe, expect, it, vi } from "vitest";
import { RequestDeduplicator } from "../../apps/server/src/request-deduplicator";

describe("RequestDeduplicator", () => {
  it("shares the result of concurrent writes with the same request id", async () => {
    const deduplicator = new RequestDeduplicator();
    const action = vi.fn(async () => ({ ok: true }));
    const first = deduplicator.run("PATCH:/resource:request-1", action);
    const duplicate = deduplicator.run("PATCH:/resource:request-1", action);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("allows a transiently failed request to be retried", async () => {
    const deduplicator = new RequestDeduplicator();
    await expect(deduplicator.run("request-2", async () => { throw new Error("temporary"); })).rejects.toThrow("temporary");
    await expect(deduplicator.run("request-2", async () => "recovered")).resolves.toBe("recovered");
  });
});
