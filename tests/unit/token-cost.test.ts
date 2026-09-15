import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectAdapterEvent } from "@codex-web/codex-adapter";
import { SessionService } from "../../apps/server/src/session-service";
import { Repositories } from "../../apps/server/src/database";
import { chooseSessionCost, estimateTokenCost, recordTokenUsage } from "../../apps/server/src/token-cost";

const totals = (inputTokens = 1_000_000, cachedInputTokens = 400_000, outputTokens = 100_000) => ({ inputTokens, cachedInputTokens, cacheWriteInputTokens: 0, outputTokens });
const ledger = () => recordTokenUsage(null, totals(), "gpt-6-astra", null);

describe("token cost fallback", () => {
  it("prefers native cost including zero and does not add duplicate local usage", () => {
    const native = { threadId: "a", status: "available" as const, estimatedUsd: "0.000000", groups: [] };
    expect(chooseSessionCost(native, ledger(), "a")).toMatchObject({ source: "codex", estimatedUsd: "0.000000" });
  });
  it("subtracts cache hits from regular input and keeps output inclusive of reasoning", () => {
    expect(chooseSessionCost(null, ledger(), "a")).toMatchObject({ source: "tokens", estimatedUsd: "11.400000" });
  });
  it("prices cache writes separately and honors fast mode", () => {
    const data = recordTokenUsage(null, { ...totals(), cacheWriteInputTokens: 100_000 }, "gpt-6-astra", "fast");
    expect(chooseSessionCost(null, data, "a").estimatedUsd).toBe("23.300000");
  });
  it("does not accumulate duplicate notifications, and records model changes by delta", () => {
    const first = ledger();
    const duplicate = recordTokenUsage(first, totals(), "gpt-6-astra", null);
    expect(duplicate.groups).toEqual(first.groups);
    const second = recordTokenUsage(duplicate, totals(2_000_000, 800_000, 200_000), "gpt-5.6-sol", null);
    expect(second.groups).toHaveLength(2);
    expect(chooseSessionCost(null, second, "a").estimatedUsd).toBe("15.960000");
  });
  it("retains spent tokens across counter resets without adding the new baseline again", () => {
    const reset = recordTokenUsage(ledger(), totals(0, 0, 0), "gpt-6-astra", null);
    expect(chooseSessionCost(null, reset, "a").estimatedUsd).toBe("11.400000");
    expect(reset.notes.join()).toContain("回退");
    const next = recordTokenUsage(reset, totals(), "gpt-6-astra", null);
    expect(chooseSessionCost(null, next, "a").estimatedUsd).toBe("22.800000");
  });
  it("uses native token groups before the local ledger and never invents unknown prices", () => {
    const native = { threadId: "a", status: "unavailable" as const, estimatedUsd: null, groups: ledger().groups };
    expect(chooseSessionCost(native, ledger(), "a").estimatedUsd).toBe("11.400000");
    const unknown = { ...native.groups[0]!, model: "custom-model" };
    expect(estimateTokenCost("a", [unknown])).toMatchObject({ status: "unavailable", estimatedUsd: null });
    expect(estimateTokenCost("a", [...native.groups, unknown]).notes?.join()).toContain("仅包含可估算部分");
    expect(chooseSessionCost(null, null, "a").notes?.join()).toContain("尚未收到");
  });
  it("extracts cumulative counters even when context window information is unavailable", () => {
    expect(projectAdapterEvent({ method: "thread/tokenUsage/updated", params: { threadId: "a", tokenUsage: { total: totals() } } })).toMatchObject({ type: "tokenUsageUpdated", totalUsage: totals() });
    expect(projectAdapterEvent({ method: "thread/tokenUsage/updated", params: { threadId: "a", tokenUsage: { total: { ...totals(), inputTokens: NaN } } } })).toBeNull();
  });
  it("routes a real H100 usage sample through service recording and the native-unavailable fallback", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cost-service-"));
    const repository = new Repositories(path.join(dir, "web.db"));
    try {
      const service = new SessionService(repository, { readSessionCost: async () => { throw new Error("Native cost unavailable"); } } as never, {} as never, { getSideChat: () => ({}) } as never);
      service.handleEvent({ type: "settingsUpdated", threadId: "smoke", settings: { model: "gpt-5.6-luna", serviceTier: "default", reasoning: null, accessMode: "fullAccess" } });
      const event = projectAdapterEvent({ method: "thread/tokenUsage/updated", params: { threadId: "smoke", tokenUsage: { total: { totalTokens: 18684, inputTokens: 18679, cachedInputTokens: 8960, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 } } } });
      service.handleEvent(event!);
      expect(await service.readSessionCost("smoke")).toMatchObject({ source: "tokens", estimatedUsd: "0.002129" });
    } finally { repository.close(); rmSync(dir, { recursive: true }); }
  });
  it("persists accounting in the Web database across restart", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cost-ledger-"));
    let repository = new Repositories(path.join(dir, "web.db"));
    try {
      repository.setCostLedger("a", ledger()); repository.close();
      repository = new Repositories(path.join(dir, "web.db"));
      expect(chooseSessionCost(null, repository.getCostLedger("a"), "a").estimatedUsd).toBe("11.400000");
    } finally { repository.close(); rmSync(dir, { recursive: true }); }
  });
});
