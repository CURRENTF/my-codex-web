import { describe, expect, it, vi } from "vitest";
import { CodexAdapter, JsonRpcError } from "@codex-web/codex-adapter";
import { projectSessionCost } from "../../packages/codex-adapter/src/session-cost";
import { formatSessionCostUsd } from "../../apps/web/src/session-cost-presentation";

const response = (estimatedUsageUsdMicros: unknown) => ({ threadUsage: {
  threadId: "session-a", estimatedUsageUsdMicros,
  groups: [{ model: "model-a", inputTokens: 1000, cachedInputTokens: "750", outputTokens: 200n },
    { model: "model-b", inputTokens: null, cachedInputTokens: null, outputTokens: null }],
} });

describe("session cost", () => {
  it.each([
    ["0.000000", "$0"], ["0.000001", "$0"], ["12.345678", "$12"],
    ["12.500000", "$13"], ["999.999999", "$1,000"], ["9007199254740993.500000", "$9,007,199,254,740,994"],
  ])("displays %s USD with zero decimal places", (value, label) => {
    expect(formatSessionCostUsd(value)).toBe(label);
  });
  it("uses the thread USD estimate without recalculating history at the current model rate", () => {
    expect(projectSessionCost("session-a", response(1_234_567))).toEqual({
      threadId: "session-a", status: "available", estimatedUsd: "1.234567",
      groups: [
        { model: "model-a", reasoningEffort: null, speed: null, inputTokens: "1000", cachedInputTokens: "750", outputTokens: "200" },
        { model: "model-b", reasoningEffort: null, speed: null, inputTokens: null, cachedInputTokens: null, outputTokens: null },
      ],
    });
  });
  it("preserves zero and micro-dollar estimates and exact large integer strings", () => {
    expect(projectSessionCost("session-a", response(0)).estimatedUsd).toBe("0.000000");
    expect(projectSessionCost("session-a", response(1n)).estimatedUsd).toBe("0.000001");
    expect(projectSessionCost("session-a", response("9007199254740993")).estimatedUsd).toBe("9007199254.740993");
  });
  it.each([null, undefined, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, "oops"])("does not turn invalid or missing cost %s into zero", (value) => {
    expect(projectSessionCost("session-a", response(value))).toMatchObject({ status: "unavailable", estimatedUsd: null });
  });
  it("never displays account-wide totals or another thread's amount", () => {
    expect(projectSessionCost("session-b", response(100))).toMatchObject({ status: "unavailable", estimatedUsd: null, groups: [] });
    expect(projectSessionCost("session-a", { summary: { estimatedUsageUsdMicros: 100 } })).toMatchObject({ status: "unavailable", estimatedUsd: null });
  });
  it("sends a thread-scoped request and exposes unsupported methods without hiding other errors", async () => {
    const request = vi.fn().mockResolvedValue(response(10));
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-cost-test", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };
    await expect(adapter.readSessionCost("session-a")).resolves.toMatchObject({ estimatedUsd: "0.000010" });
    expect(request).toHaveBeenCalledWith("account/usage/read", { threadId: "session-a" }, 5_000);
    request.mockRejectedValueOnce(new JsonRpcError("Method not found", -32601));
    await expect(adapter.readSessionCost("session-a")).resolves.toMatchObject({ status: "unsupported" });
    request.mockRejectedValueOnce(new JsonRpcError("Invalid request: invalid type: map, expected unit", -32600));
    await expect(adapter.readSessionCost("session-a")).resolves.toMatchObject({ status: "unsupported" });
    request.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(adapter.readSessionCost("session-a")).rejects.toThrow("Disconnected");
  });
});
