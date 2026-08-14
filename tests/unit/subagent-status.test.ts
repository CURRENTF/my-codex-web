import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SubagentRuntime } from "@codex-web/shared-types";
import { SubagentStatusView } from "../../apps/web/src/components/SubagentStatus";
import { descendantSubagents, effectiveSubagentSettings, subagentStateLabel } from "../../apps/web/src/subagent-presentation";

function agent(overrides: Partial<SubagentRuntime> & Pick<SubagentRuntime, "threadId" | "parentThreadId">): SubagentRuntime {
  return {
    forkedFromId: null,
    contextMode: "unknown",
    sourceKind: "unknown",
    depth: null,
    agentPath: null,
    agentNickname: null,
    agentRole: null,
    createdAt: 1,
    requestedModel: null,
    requestedReasoning: null,
    model: null,
    reasoning: null,
    prompt: null,
    state: "idle",
    activeFlags: [],
    pendingRequestIds: [],
    ...overrides,
  };
}

describe("Subagent status", () => {
  it("sorts siblings by creation time and preserves nested hierarchy", () => {
    const entries = descendantSubagents([
      agent({ threadId: "later", parentThreadId: "root", createdAt: 3 }),
      agent({ threadId: "nested", parentThreadId: "earlier", createdAt: 2 }),
      agent({ threadId: "earlier", parentThreadId: "root", createdAt: 1 }),
    ], "root");

    expect(entries.map(({ agent: item, nestingDepth }) => [item.threadId, nestingDepth])).toEqual([
      ["earlier", 0],
      ["nested", 1],
      ["later", 0],
    ]);
  });

  it("resolves actual settings before requested and inherited settings", () => {
    const parent = agent({ threadId: "parent", parentThreadId: "root", model: "gpt-parent", reasoning: "high" });
    const child = agent({ threadId: "child", parentThreadId: "parent", requestedReasoning: "max" });
    const inherited = effectiveSubagentSettings(child, new Map([[parent.threadId, parent], [child.threadId, child]]), {
      model: "gpt-root",
      reasoning: "medium",
    });

    expect(inherited).toEqual({ model: "gpt-parent", reasoning: "max", inheritedModel: true, inheritedReasoning: false });
    expect(effectiveSubagentSettings({ ...child, model: "gpt-actual" }, new Map(), { model: "gpt-root", reasoning: "medium" })).toMatchObject({
      model: "gpt-actual",
      reasoning: "max",
      inheritedModel: false,
      inheritedReasoning: false,
    });
  });

  it("uses precise lifecycle labels for initializing and completed agents", () => {
    expect(subagentStateLabel(agent({ threadId: "pending", parentThreadId: "root", agentStatus: "pendingInit" }))).toBe("初始化");
    expect(subagentStateLabel(agent({ threadId: "done", parentThreadId: "root", agentStatus: "completed" }))).toBe("已完成");
    expect(subagentStateLabel(agent({ threadId: "unloaded", parentThreadId: "root", agentStatus: "shutdown" }))).toBe("已关闭");
    expect(subagentStateLabel(agent({ threadId: "unloaded", parentThreadId: "root", agentStatus: "notLoaded" }))).toBe("未加载");
  });

  it("renders an expanded active tree with context, model, effort, and inheritance", () => {
    const child = agent({
      threadId: "child",
      parentThreadId: "root",
      forkedFromId: "root",
      contextMode: "forked",
      sourceKind: "threadSpawn",
      agentNickname: "reviewer",
      agentRole: "reviewer",
      agentPath: "review/nested",
      state: "running",
      requestedReasoning: "max",
    });
    const html = renderToStaticMarkup(createElement(SubagentStatusView, {
      parentThreadId: "root",
      rootSettings: { model: "gpt-5.6-sol", reasoning: "high" },
      allAgents: [child],
    }));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("reviewer");
    expect(html).toContain("review/nested");
    expect(html).toContain("Fork 上下文");
    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("max");
    expect(html).toContain("继承");
    expect(html).toContain('aria-label="正在执行"');
    expect(html).toContain("正在执行");
  });
});
