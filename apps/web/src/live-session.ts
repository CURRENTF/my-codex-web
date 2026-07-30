import { mergeStreamingText, type ItemDeltaUiEventPayload, type ItemUiEventPayload, type TurnUiEventPayload, type UiEvent } from "@codex-web/shared-types";
import type { CodexItem, CodexTurn, Goal, SessionPayload } from "./api";

function terminalizeItem(item: CodexItem, turnStatus: CodexTurn["status"]): CodexItem {
  if (turnStatus === "inProgress" || !("status" in item) || item.status !== "inProgress") return item;
  return { ...item, status: turnStatus === "completed" ? "completed" : turnStatus };
}

function terminalizeTurn(turn: CodexTurn): CodexTurn {
  if (turn.status === "inProgress") return turn;
  return { ...turn, items: turn.items.map((item) => terminalizeItem(item, turn.status)) };
}

function mergeItemSnapshot(existing: CodexItem, incoming: CodexItem): CodexItem {
  if (existing.type === "commandExecution" && incoming.type === "commandExecution") {
    return { ...existing, ...incoming, aggregatedOutput: mergeStreamingText(existing.aggregatedOutput, incoming.aggregatedOutput) || null };
  }
  if (existing.type === "userMessage" && incoming.type === "userMessage") {
    const content = Array.from({ length: Math.max(existing.content.length, incoming.content.length) }, (_, index) => {
      const previous = existing.content[index];
      const next = incoming.content[index];
      if (!next) return previous!;
      if (!previous || previous.type !== next.type) return next;
      return { ...previous, ...next };
    });
    return { ...existing, ...incoming, clientId: incoming.clientId ?? existing.clientId, content };
  }
  return incoming;
}

function itemSnapshotIndex(items: CodexItem[], incoming: CodexItem): number {
  const byId = items.findIndex((candidate) => candidate.id === incoming.id);
  if (byId >= 0 || incoming.type !== "userMessage" || !incoming.clientId) return byId;
  return items.findIndex((candidate) => candidate.type === "userMessage" && candidate.clientId === incoming.clientId);
}

function upsertTurn(turns: CodexTurn[], incoming: CodexTurn): CodexTurn[] {
  incoming = terminalizeTurn(incoming);
  const index = turns.findIndex((turn) => turn.id === incoming.id);
  if (index < 0) return [...turns, incoming];
  const current = turns[index]!;
  const next = [...turns];
  const items = [...current.items];
  for (const item of incoming.items) {
    const itemIndex = itemSnapshotIndex(items, item);
    if (itemIndex < 0) items.push(item);
    else {
      items[itemIndex] = mergeItemSnapshot(items[itemIndex]!, item);
    }
  }
  next[index] = terminalizeTurn({ ...current, ...incoming, items });
  return next;
}

function upsertItem(turns: CodexTurn[], turnId: string, item: CodexItem, startedAtMs?: number): CodexTurn[] {
  const turnIndex = turns.findIndex((turn) => turn.id === turnId);
  if (turnIndex < 0) {
    return [...turns, {
      id: turnId,
      status: "inProgress",
      items: [item],
      startedAt: startedAtMs ? Math.floor(startedAtMs / 1_000) : null,
      completedAt: null,
      durationMs: null,
    }];
  }
  const turn = turns[turnIndex]!;
  item = terminalizeItem(item, turn.status);
  const items = [...turn.items];
  const itemIndex = itemSnapshotIndex(items, item);
  if (itemIndex < 0) items.push(item);
  else {
    items[itemIndex] = mergeItemSnapshot(items[itemIndex]!, item);
  }
  const next = [...turns];
  next[turnIndex] = { ...turn, items };
  return next;
}

function appendCommandDelta(turns: CodexTurn[], itemId: string, delta: string): CodexTurn[] {
  return turns.map((turn) => {
    const itemIndex = turn.items.findIndex((item) => item.id === itemId && item.type === "commandExecution");
    if (itemIndex < 0) return turn;
    const items = [...turn.items];
    const command = items[itemIndex] as Extract<CodexItem, { type: "commandExecution" }>;
    items[itemIndex] = { ...command, aggregatedOutput: `${command.aggregatedOutput ?? ""}${delta}` || null };
    return { ...turn, items };
  });
}

export function applySessionEvent(
  current: SessionPayload | undefined,
  event: UiEvent,
  liveDeltas: Record<string, string> = {},
): SessionPayload | undefined {
  if (!current || !event.threadId || current.thread.id !== event.threadId) return current;
  if (event.type === "session.settings.updated") {
    const settings = (event.payload as { settings?: SessionPayload["settings"] }).settings;
    return settings ? { ...current, settings } : current;
  }
  if (event.type === "goal.cleared") return { ...current, goal: null };
  if (event.type === "goal.updated") {
    const goal = (event.payload as { goal?: Goal }).goal;
    return goal ? { ...current, goal } : current;
  }
  if (event.type === "turn.started" || event.type === "turn.completed") {
    const turn = (event.payload as Partial<TurnUiEventPayload>).turn;
    return turn ? { ...current, thread: { ...current.thread, turns: upsertTurn(current.thread.turns, turn) } } : current;
  }
  if (event.type === "item.upserted") {
    const { turnId, item, startedAtMs } = event.payload as Partial<ItemUiEventPayload>;
    if (!turnId || !item) return current;
    const hydratedItem = item.type === "commandExecution" && liveDeltas[item.id]
      ? { ...item, aggregatedOutput: mergeStreamingText(liveDeltas[item.id], item.aggregatedOutput) || null }
      : item;
    return { ...current, thread: { ...current.thread, turns: upsertItem(current.thread.turns, turnId, hydratedItem, startedAtMs) } };
  }
  if (event.type === "item.delta") {
    const { itemId, delta, kind } = event.payload as Partial<ItemDeltaUiEventPayload>;
    if (kind !== "commandOutput" || !itemId || !delta) return current;
    return { ...current, thread: { ...current.thread, turns: appendCommandDelta(current.thread.turns, itemId, delta) } };
  }
  return current;
}
