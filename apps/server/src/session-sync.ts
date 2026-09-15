import { createHash } from "node:crypto";

// Hash the wire representation, including item contents, rather than IDs or timestamps.
export function sessionSyncResponse<T extends { thread: { turns: { status: string }[] } }>(
  payload: T, prefixCount = 0, prefixHash = "",
) {
  const turns = payload.thread.turns;
  const activeIndex = turns.findIndex((turn) => turn.status === "inProgress");
  const stableCount = activeIndex < 0 ? turns.length : activeIndex;
  const hash = createHash("sha256").update("session-prefix-v1");
  let matched = prefixCount === 0;
  for (let index = 0; index < stableCount; index++) {
    hash.update(JSON.stringify(turns[index])).update("\n");
    if (index + 1 === prefixCount) matched = hash.copy().digest("hex") === prefixHash;
  }
  const stableHash = hash.digest("hex");
  const retainedCount = matched && prefixCount <= stableCount ? prefixCount : 0;
  return {
    ...payload,
    thread: { ...payload.thread, turns: turns.slice(retainedCount) },
    sync: { version: 1 as const, retainedCount, prefixCount: stableCount, prefixHash: stableHash },
  };
}
