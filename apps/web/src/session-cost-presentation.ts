/** Round the decimal USD value for display without losing precision to Number. */
export function formatSessionCostUsd(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const rounded = BigInt(whole!) + (fraction[0] && fraction[0] >= "5" ? 1n : 0n);
  return `$${rounded.toLocaleString("en-US")}`;
}
