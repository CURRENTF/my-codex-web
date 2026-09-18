import { describe, expect, it } from "vitest";
import { reconcileAgentMessageHistory, type SessionItem } from "@codex-web/shared-types";

const message = (id: string, text: string): SessionItem => ({ type: "agentMessage", id, text, phase: "commentary" });

describe("assistant history reconciliation", () => {
  it("removes a retired stream before a persisted replacement, without text matching", () => {
    const old = message("abandoned", "我先确认仓库位置");
    const replacement = message("persisted", "我先确认仓库位置，查看 README、配置和测试入口。");
    const pending = message("pending", "新的流式回复");
    expect(reconcileAgentMessageHistory([replacement], [old, replacement, pending])).toEqual([replacement, pending]);
  });

  it("retains distinct persisted messages even when one is a prefix of the other", () => {
    const items = [message("one", "检查"), message("two", "检查代码")];
    expect(reconcileAgentMessageHistory(items, items)).toEqual(items);
  });

  it("does not guess when history has no shared anchor or contains only an earlier item", () => {
    const old = message("old", "检查");
    const current = message("current", "检查代码");
    expect(reconcileAgentMessageHistory([current], [old])).toEqual([old]);
    expect(reconcileAgentMessageHistory([old], [old, current])).toEqual([old, current]);
    expect(reconcileAgentMessageHistory([], [old, current])).toEqual([old, current]);
  });

  it("preserves cached tools, user messages, and async questions omitted by history", () => {
    const end = message("end", "完成");
    const items: SessionItem[] = [
      { type: "userMessage", id: "user", content: [{ type: "text", text: "继续" }] },
      { type: "reasoning", id: "reasoning", summary: ["thinking"] },
      { type: "agentMessage", id: "question", text: "", delivery: "async" },
      end,
    ];
    expect(reconcileAgentMessageHistory([end], items)).toEqual(items);
  });
});
