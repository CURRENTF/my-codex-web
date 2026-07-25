import { mergeStreamingText } from "@codex-web/shared-types";
import type { SessionTurn } from "@codex-web/shared-types";

export interface CommandResultDisplay {
  label: string;
  tone: "ok" | "running" | "bad" | "interrupted";
}

export function commandResultDisplay(
  status: string,
  exitCode: number | null,
  turnStatus: SessionTurn["status"],
): CommandResultDisplay {
  if (exitCode === null) {
    return {
      label: status,
      tone: status === "inProgress" ? "running" : status === "failed" ? "bad" : "interrupted",
    };
  }
  if (turnStatus === "interrupted" && status === "completed") {
    return { label: `Turn 已中断 · exit ${exitCode}`, tone: exitCode === 0 ? "interrupted" : "bad" };
  }
  if (turnStatus === "failed" && status === "completed") {
    return { label: `Turn 失败 · exit ${exitCode}`, tone: "bad" };
  }
  return { label: `exit ${exitCode}`, tone: exitCode === 0 ? "ok" : "bad" };
}

export function commandOutputText(
  aggregatedOutput: string | null,
  liveDelta: string | undefined,
  expanded: boolean,
): string {
  const output = mergeStreamingText(aggregatedOutput, liveDelta).replace(/\n+$/, "");
  if (expanded) return output;
  return output.split("\n").slice(-3).join("\n");
}
