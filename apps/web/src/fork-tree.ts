import type { SessionSummary } from "@codex-web/shared-types";

export interface ForkTreeNode {
  id: string;
  title: string;
  session: SessionSummary | null;
  children: ForkTreeNode[];
}

// The unfiltered catalog is intentional: sidebar search and project moves must
// not change a conversation's ancestry. Missing parents remain structural only.
export function sessionForkTree(sessions: SessionSummary[], threadId: string): ForkTreeNode | null {
  const byId = new Map(sessions.map((session) => [session.threadId, session]));
  const current = byId.get(threadId);
  if (!current) return null;
  let rootId = threadId;
  const ancestors = new Set<string>();
  while (!ancestors.has(rootId)) {
    ancestors.add(rootId);
    const parentId = byId.get(rootId)?.parentThreadId;
    if (!parentId) break;
    rootId = parentId;
  }
  const children = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    if (!session.parentThreadId) continue;
    const siblings = children.get(session.parentThreadId) ?? [];
    siblings.push(session);
    children.set(session.parentThreadId, siblings);
  }
  const visited = new Set<string>();
  const build = (id: string): ForkTreeNode => {
    visited.add(id);
    const session = byId.get(id) ?? null;
    const boundary = (child: SessionSummary) => child.forkTurnNumber ?? (!child.forkTurnId && child.origin === "forked" ? 0 : Infinity);
    const descendants = [...(children.get(id) ?? [])].sort((a, b) =>
      boundary(a) - boundary(b)
      || a.createdAt - b.createdAt || a.threadId.localeCompare(b.threadId));
    return {
      id,
      title: session?.title ?? descendants[0]?.forkSourceTitle ?? "原始对话不可用",
      session,
      children: descendants.filter((child) => !visited.has(child.threadId)).map((child) => build(child.threadId)),
    };
  };
  const tree = build(rootId);
  return visited.size > 1 ? tree : null;
}

export function forkPositionLabel(session: SessionSummary): string {
  if (!session.parentThreadId) return "原始对话";
  if (session.forkTurnNumber !== null) return `第 ${session.forkTurnNumber} 轮后分叉`;
  return !session.forkTurnId && session.origin === "forked" ? "从开头分叉" : "分叉位置未知";
}

export interface ForkTreeEntry {
  node: ForkTreeNode;
  depth: number;
  start: number;
  end: number;
  parentDepth: number | null;
  activePath: boolean;
  activeEnd: number;
}

// Rows express ancestry and branch order, not elapsed time or message counts.
// A parent's continuation gets its own tip, so every session has one leaf.
export function layoutForkTree(root: ForkTreeNode, threadId: string): ForkTreeEntry[] {
  const entries: ForkTreeEntry[] = [];
  let row = 16;
  const visit = (node: ForkTreeNode, depth: number, start: number): boolean => {
    const entry: ForkTreeEntry = { node, depth, start, end: start, parentDepth: depth ? depth - 1 : null, activePath: node.id === threadId, activeEnd: start };
    entries.push(entry);
    for (const child of node.children) {
      row += 28;
      const junction = row;
      const activeChild = visit(child, depth + 1, row);
      entry.activePath ||= activeChild;
      if (activeChild) entry.activeEnd = junction;
    }
    row += 44;
    entry.end = row;
    if (node.id === threadId) entry.activeEnd = row;
    return entry.activePath;
  };
  visit(root, 0, row);
  return entries;
}
