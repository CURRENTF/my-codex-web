import type { SessionCost } from "@codex-web/shared-types";

/** Round the decimal USD value for display without losing precision to Number. */
export function formatSessionCostUsd(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const rounded = BigInt(whole!) + (fraction[0] && fraction[0] >= "5" ? 1n : 0n);
  return `$${rounded.toLocaleString("en-US")}`;
}
export function sessionCostLabel(data: SessionCost | undefined): string {
  if (data?.estimatedUsd != null) return `${formatSessionCostUsd(data.estimatedUsd)}${data.partial ? "（部分）" : ""}`;
  switch (data?.unavailableReason) {
    case "noUsage": return "用量待更新";
    case "missingPricing": return "缺少价格";
    case "incompleteUsage": return "用量不完整";
    default: return "费用未知";
  }
}
