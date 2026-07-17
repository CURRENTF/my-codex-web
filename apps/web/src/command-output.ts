import { mergeStreamingText } from "@codex-web/shared-types";

export function commandOutputText(
  aggregatedOutput: string | null,
  liveDelta: string | undefined,
  expanded: boolean,
): string {
  const output = mergeStreamingText(aggregatedOutput, liveDelta).replace(/\n+$/, "");
  if (expanded) return output;
  return output.split("\n").slice(-3).join("\n");
}
