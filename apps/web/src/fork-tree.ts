import type { SessionSummary } from "@codex-web/shared-types";
import type { CodexTurn } from "./api";
import type { UserMessageTarget } from "./user-message-navigation";

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

export interface MessageRailBranch {
  node: ForkTreeNode;
  column: number;
  parentColumn: number | null;
  start: number;
  end: number;
  sharedUntil: number;
}

export function messageRailBranches(sessions: SessionSummary[], threadId: string, turns: CodexTurn[], targets: UserMessageTarget[]): {
  branches: MessageRailBranch[]; messageColumns: number[]; rowCount: number;
} {
  const tree = sessionForkTree(sessions, threadId);
  if (!tree) return { branches: [], messageColumns: targets.map(() => 0), rowCount: targets.length };
  const flat: { node: ForkTreeNode; parentId: string | null; boundary: number }[] = [];
  const flatten = (node: ForkTreeNode, parentId: string | null) => {
    const matchedTurn = node.session?.forkTurnId ? turns.findIndex((turn) => turn.id === node.session!.forkTurnId) : -1;
    const boundary = !parentId ? 0 : matchedTurn >= 0 ? matchedTurn + 1 : node.session?.forkTurnNumber
      ?? (!node.session?.forkTurnId && node.session?.origin === "forked" ? 0 : null);
    // Imported sessions may have ancestry without a recorded Turn boundary.
    // Keep those in the full tree rather than draw a guessed junction here.
    if (boundary === null) return;
    flat.push({ node, parentId, boundary });
    node.children.forEach((child) => flatten(child, node.id));
  };
  flatten(tree, null);
  if (flat.length < 2 || !flat.some((entry) => entry.node.id === threadId)) {
    return { branches: [], messageColumns: targets.map(() => 0), rowCount: targets.length };
  }
  const byId = new Map(flat.map((entry) => [entry.node.id, entry]));
  // Forking earlier than the parent's own fork branches from its inherited
  // prefix. Route that junction to the ancestor that owns the prefix.
  for (const entry of flat) {
    let parent = entry.parentId ? byId.get(entry.parentId) : undefined;
    while (parent?.parentId && parent.boundary > entry.boundary) parent = byId.get(parent.parentId);
    entry.parentId = parent?.node.id ?? null;
  }
  const path = new Map<string, number>();
  let current = byId.get(threadId);
  let until = Infinity;
  while (current && !path.has(current.node.id)) {
    path.set(current.node.id, until);
    until = current.boundary;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  const turnRow = (turnIndex: number) => {
    const index = targets.findIndex((target) => !target.optimistic && target.turnIndex >= turnIndex);
    return index >= 0 ? index : targets.length + Math.max(0, turnIndex - turns.length);
  };
  const columns = new Map(flat.map((entry, index) => [entry.node.id, index]));
  const branches = flat.map(({ node, parentId, boundary }): MessageRailBranch => {
    const childBoundaries = flat.filter((child) => child.parentId === node.id).map((child) => child.boundary);
    const count = node.id === threadId ? turns.length : node.session?.turnCount;
    const knownEnd = Math.max(boundary, count ?? boundary, ...childBoundaries);
    // Unknown tails get one session marker, never invented message ticks.
    const end = node.id === threadId ? Math.max(0, targets.length - 1)
      : count === undefined ? Math.max(turnRow(boundary), turnRow(knownEnd) - .25)
      : Math.max(turnRow(boundary) - .15, turnRow(knownEnd) - 1);
    const sharedUntil = path.has(node.id) ? path.get(node.id)! : boundary;
    return {
      node, column: columns.get(node.id)!, parentColumn: parentId ? columns.get(parentId)! : null,
      start: Math.max(0, turnRow(boundary) - .5),
      end: node.id === threadId ? end : Math.max(end, Math.max(0, turnRow(sharedUntil) - .5) + .45),
      sharedUntil: sharedUntil === Infinity ? Infinity : turnRow(sharedUntil) - .5,
    };
  });
  const messageColumns = targets.map((target) => {
    if (target.optimistic) return columns.get(threadId) ?? 0;
    const owner = flat.find((entry) => path.has(entry.node.id) && target.turnIndex >= entry.boundary && target.turnIndex < path.get(entry.node.id)!);
    return owner ? columns.get(owner.node.id)! : 0;
  });
  return { branches, messageColumns, rowCount: Math.max(targets.length, ...branches.map((branch) => Math.ceil(branch.end) + 1)) };
}
