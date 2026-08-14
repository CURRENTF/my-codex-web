import type { ListedSubagent } from "@codex-web/codex-adapter";

export interface SubagentSnapshotSource {
  listSubagents(cursor?: string | null, limit?: number): Promise<{ data: ListedSubagent[]; nextCursor: string | null }>;
}

export interface SubagentSnapshotTarget {
  restoreSubagents(subagents: readonly ListedSubagent[]): void;
}

export async function restoreSubagentSnapshot(
  source: SubagentSnapshotSource,
  target: SubagentSnapshotTarget,
  pageSize = 100,
): Promise<number> {
  const restored: ListedSubagent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await source.listSubagents(cursor, pageSize);
    restored.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error("Codex App Server returned a repeated Subagent pagination cursor");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  target.restoreSubagents(restored);
  return restored.length;
}
