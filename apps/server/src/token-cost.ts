import type { SessionCost } from "@codex-web/shared-types";
import type { TokenTotals } from "@codex-web/codex-adapter";

export type CostGroup = SessionCost["groups"][number];
export interface CostLedger { total: TokenTotals; groups: CostGroup[]; notes: string[] }
const keys = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens"] as const;

// Prices in thousandths of USD per million tokens. Verified against
// https://developers.openai.com/api/docs/pricing on 2026-10-15.
// This is explicitly a short-context reference estimate, not a billing replica.
const rates: Record<string, readonly [number, number, number, number]> = {
  "gpt-6-astra": [10000, 1000, 12500, 50000],
  "gpt-6.1-sol": [2000, 100, 2500, 10000],
  "gpt-6-sol": [2000, 200, 2500, 10000],
  "gpt-6-luna": [100, 10, 125, 500],
  "gpt-5.6-sol": [4000, 400, 5000, 20000],
  "gpt-5.6-terra": [2000, 200, 2500, 12000],
  "gpt-5.6-luna": [200, 20, 250, 1200],
  "gpt-5.5": [5000, 500, 0, 30000],
  "gpt-5.3-codex": [1750, 175, 0, 14000],
};

export function recordTokenUsage(previous: CostLedger | null, total: TokenTotals, model: string | null, speed: string | null): CostLedger {
  const ledger: CostLedger = previous ? structuredClone(previous) : { total, groups: [], notes: ["首次收到的历史累计用量按当时模型和服务档位估算；历史模型分段可能不完整。"] };
  // Rollbacks or provider counter resets cannot refund already consumed tokens.
  if (previous && keys.some((key) => total[key] < previous.total[key])) {
    ledger.total = total;
    ledger.notes = [...new Set([...ledger.notes, "检测到用量计数回退，已保留此前消耗；后续按新计数累计。"] )];
    return ledger;
  }
  const delta = Object.fromEntries(keys.map((key) => [key, BigInt(total[key]) - BigInt(previous?.total[key] ?? 0)]));
  if (Object.values(delta).some((n) => n > 0n)) {
    let group = ledger.groups.find((row) => row.model === model && row.speed === speed);
    if (!group) { group = { model, speed, reasoningEffort: null, inputTokens: "0", cachedInputTokens: "0", cacheWriteInputTokens: "0", outputTokens: "0" }; ledger.groups.push(group); }
    for (const key of keys) group[key] = (BigInt(group[key] ?? "0") + delta[key]!).toString();
  }
  ledger.total = total;
  return ledger;
}

function count(value: string | null | undefined): bigint | null {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

export function estimateTokenCost(threadId: string, groups: CostGroup[], notes: string[] = []): SessionCost {
  let nanoUsd = 0n, priced = 0, missing = 0;
  const missingModels = new Set<string>(), missingTiers = new Set<string>();
  let incomplete = false;
  for (const group of groups) {
    const price = group.model && Object.hasOwn(rates, group.model) ? rates[group.model] : undefined;
    if (!price) { missingModels.add(group.model ?? "未知模型"); missing++; continue; }
    const input = count(group.inputTokens), cached = count(group.cachedInputTokens), output = count(group.outputTokens);
    const writes = count(group.cacheWriteInputTokens ?? "0");
    if (input === null || cached === null || output === null || writes === null || cached + writes > input) { incomplete = true; missing++; continue; }
    if (writes > 0n && price[2] === 0) { missingModels.add(`${group.model}（缓存写入）`); missing++; continue; }
    const speed = group.speed?.toLowerCase();
    const ultrafast = speed === "ultrafast" && ["gpt-6-astra", "gpt-6.1-sol"].includes(group.model!);
    if (speed && !["default", "standard", "priority", "fast", "flex", "batch"].includes(speed) && !ultrafast) {
      missingTiers.add(`${group.model} / ${group.speed}`); missing++; continue;
    }
    let amount = (input - cached - writes) * BigInt(price[0]) + cached * BigInt(price[1]) + writes * BigInt(price[2]) + output * BigInt(price[3]);
    if (speed === "fast" || speed === "priority") amount = group.model === "gpt-5.5" ? amount * 5n / 2n : amount * 2n;
    if (ultrafast) amount *= 6n;
    if (speed === "flex" || speed === "batch") amount /= 2n;
    nanoUsd += amount; priced++;
  }
  const micros = (nanoUsd + 500n) / 1000n;
  const unavailableReason: SessionCost["unavailableReason"] = !groups.length ? "noUsage"
    : missingModels.size || missingTiers.size ? "missingPricing" : "incompleteUsage";
  return { threadId, status: priced ? "available" : "unavailable", source: "tokens", pricingDate: "2026-10-15",
    ...(!priced ? { unavailableReason } : {}),
    partial: priced > 0 && missing > 0,
    estimatedUsd: priced ? `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}` : null, groups,
    notes: [...notes, "按公开短上下文 API 单价和服务档位估算；未计长上下文加价、地区附加费或工具费用。",
      ...(missingModels.size ? [`缺少模型单价：${[...missingModels].join("、")}。`] : []),
      ...(missingTiers.size ? [`缺少服务档位价格：${[...missingTiers].join("、")}。`] : []),
      ...(incomplete ? ["部分 token 明细缺失或无效，无法估算对应用量。"] : []),
      ...(priced && missing ? ["金额仅包含可估算部分。"] : []),
      ...(!groups.length ? ["尚未收到累计 token 用量；会话产生新的用量更新后可估算。"] : [])] };
}

export function chooseSessionCost(native: SessionCost | null, ledger: CostLedger | null, threadId: string): SessionCost {
  if (native?.estimatedUsd != null) return { ...native, source: "codex" };
  // Native groups represent the same session: never add them to the local ledger.
  if (native?.groups.length) return estimateTokenCost(threadId, native.groups);
  return estimateTokenCost(threadId, ledger?.groups ?? [], ledger?.notes);
}
