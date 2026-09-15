import type { SessionCost } from "@codex-web/shared-types";

// Protocol integers may arrive as JSON numbers or decimal strings. Reject unsafe
// numbers rather than silently displaying rounded billing data.
function integer(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

export function projectSessionCost(threadId: string, response: unknown): SessionCost {
  const empty: SessionCost = { threadId, status: "unavailable", estimatedUsd: null, groups: [] };
  if (!response || typeof response !== "object" || !("threadUsage" in response)) return empty;
  const usage = response.threadUsage;
  if (!usage || typeof usage !== "object" || !("threadId" in usage) || usage.threadId !== threadId) return empty;
  const record = usage as Record<string, unknown>;
  const micros = integer(record.estimatedUsageUsdMicros);
  const groups = Array.isArray(record.groups) ? record.groups.flatMap((group: unknown) => {
    if (!group || typeof group !== "object") return [];
    const row = group as Record<string, unknown>;
    const text = (key: string) => typeof row[key] === "string" ? row[key] as string : null;
    return [{ model: text("model"), reasoningEffort: text("reasoningEffort"), speed: text("speed"),
      inputTokens: integer(row.inputTokens)?.toString() ?? null,
      cachedInputTokens: integer(row.cachedInputTokens)?.toString() ?? null,
      outputTokens: integer(row.outputTokens)?.toString() ?? null }];
  }) : [];
  return { threadId, status: micros === null ? "unavailable" : "available",
    estimatedUsd: micros === null ? null : `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}`, groups };
}
