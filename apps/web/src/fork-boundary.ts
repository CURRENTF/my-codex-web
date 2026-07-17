import type { CodexTurn } from "./api";

export function forkBoundaryForTurn(turns: CodexTurn[], index: number): { canFork: boolean; previousCompletedTurnId: string | null } {
  const turn = turns[index];
  const previousCompletedTurnId = turns
    .slice(0, index)
    .reverse()
    .find((candidate) => candidate.status === "completed")?.id ?? null;
  return { canFork: turn?.status === "completed", previousCompletedTurnId };
}

export function questionForTurn(turns: CodexTurn[], turnId: string): string {
  const turn = turns.find((candidate) => candidate.id === turnId);
  const item = turn?.items.find((candidate) => candidate.type === "userMessage") as Extract<CodexTurn["items"][number], { type: "userMessage" }> | undefined;
  return item?.content.map((part) => part.text ?? "").join("\n") ?? "";
}
