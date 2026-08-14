import type { RuntimeState, SubagentRuntime } from "@codex-web/shared-types";

export interface SubagentTreeEntry {
  agent: SubagentRuntime;
  nestingDepth: number;
}

export interface EffectiveSubagentSettings {
  model: string;
  reasoning: string;
  inheritedModel: boolean;
  inheritedReasoning: boolean;
}

export function descendantSubagents(subagents: readonly SubagentRuntime[], parentThreadId: string): SubagentTreeEntry[] {
  const children = new Map<string, SubagentRuntime[]>();
  for (const agent of subagents) {
    const siblings = children.get(agent.parentThreadId) ?? [];
    siblings.push(agent);
    children.set(agent.parentThreadId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left.createdAt - right.createdAt || left.threadId.localeCompare(right.threadId));
  const result: SubagentTreeEntry[] = [];
  const visited = new Set<string>();
  const visit = (threadId: string, nestingDepth: number) => {
    for (const agent of children.get(threadId) ?? []) {
      if (visited.has(agent.threadId)) continue;
      visited.add(agent.threadId);
      result.push({ agent, nestingDepth });
      visit(agent.threadId, nestingDepth + 1);
    }
  };
  visit(parentThreadId, 0);
  return result;
}

export function displaySubagentState(agent: SubagentRuntime): RuntimeState {
  if (agent.state !== "idle") return agent.state;
  if (agent.agentStatus === "pendingInit" || agent.agentStatus === "running") return "running";
  if (agent.agentStatus === "completed") return "justFinished";
  if (agent.agentStatus === "shutdown" || agent.agentStatus === "notLoaded") return "idle";
  if (agent.agentStatus === "interrupted") return "interrupted";
  if (agent.agentStatus === "errored" || agent.agentStatus === "notFound") return "failed";
  return "idle";
}

export function subagentDisplayName(agent: SubagentRuntime): string {
  return agent.agentNickname || agent.agentRole || agent.agentPath?.split("/").filter(Boolean).at(-1) || `Agent ${agent.threadId.slice(0, 6)}`;
}

export function effectiveSubagentSettings(
  agent: SubagentRuntime,
  agentsById: ReadonlyMap<string, SubagentRuntime>,
  root: { model: string | null; reasoning: string | null },
): EffectiveSubagentSettings {
  const visited = new Set<string>([agent.threadId]);
  let parent = agentsById.get(agent.parentThreadId);
  let inheritedModel = agent.model === null && agent.requestedModel === null;
  let inheritedReasoning = agent.reasoning === null && agent.requestedReasoning === null;
  let model = agent.model ?? agent.requestedModel;
  let reasoning = agent.reasoning ?? agent.requestedReasoning;
  while (parent && (!model || !reasoning) && !visited.has(parent.threadId)) {
    visited.add(parent.threadId);
    model ??= parent.model ?? parent.requestedModel;
    reasoning ??= parent.reasoning ?? parent.requestedReasoning;
    parent = agentsById.get(parent.parentThreadId);
  }
  model ??= root.model;
  reasoning ??= root.reasoning;
  return {
    model: model || "默认模型",
    reasoning: reasoning || "默认 effort",
    inheritedModel,
    inheritedReasoning,
  };
}

export function subagentContextLabel(agent: SubagentRuntime): string {
  if (agent.contextMode === "forked") return "Fork 上下文";
  if (agent.contextMode === "isolated") return "无 Fork 上下文";
  return "上下文待确认";
}

export function subagentStateLabel(agent: SubagentRuntime, state = displaySubagentState(agent)): string {
  if (state === "disconnected") return "连接中断";
  if (state === "waitingForInput") return "等待确认";
  if (state === "failed") return agent.agentStatus === "notFound" ? "未找到" : "失败";
  if (state === "interrupted") return "已中断";
  if (state === "justFinished") return "已完成";
  if (state === "running") return agent.agentStatus === "pendingInit" ? "初始化" : "正在执行";
  if (agent.agentStatus === "completed") return "已完成";
  if (agent.agentStatus === "shutdown") return "已关闭";
  if (agent.agentStatus === "notLoaded") return "未加载";
  return "空闲";
}
