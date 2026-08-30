import { useMemo } from "react";
import { Brain, GitFork, UsersThree } from "@phosphor-icons/react";
import * as Popover from "@radix-ui/react-popover";
import type { SubagentRuntime } from "@codex-web/shared-types";
import { useAppStore } from "../store";
import { descendantSubagents, displaySubagentState, effectiveSubagentSettings, subagentContextLabel, subagentDisplayName, subagentStateLabel } from "../subagent-presentation";
import { StatusIcon } from "./StatusIcon";

const ACTIVE_STATES = new Set(["running", "waitingForInput"]);

export function SubagentAgentRow({ agent, nestingDepth, agentsById, rootSettings }: {
  agent: SubagentRuntime;
  nestingDepth: number;
  agentsById: ReadonlyMap<string, SubagentRuntime>;
  rootSettings: { model: string | null; reasoning: string | null };
}) {
  const state = displaySubagentState(agent);
  const settings = effectiveSubagentSettings(agent, agentsById, rootSettings);
  const secondary = [agent.agentRole !== subagentDisplayName(agent) ? agent.agentRole : null, agent.agentPath].filter(Boolean).join(" / ");
  const statusLabel = subagentStateLabel(agent, state);
  return <div className="subagent-row" role="listitem" style={{ paddingLeft: `${12 + Math.min(nestingDepth, 4) * 18}px` }} data-state={state} title={agent.statusMessage ?? agent.prompt ?? undefined}>
    <StatusIcon state={state} size={16} label={statusLabel} />
    <div className="subagent-identity"><strong>{subagentDisplayName(agent)}</strong>{secondary && <small title={secondary}>{secondary}</small>}</div>
    <div className="subagent-meta">
      <span className="subagent-context"><GitFork size={12} />{subagentContextLabel(agent)}</span>
      <code title={`模型：${settings.model}${settings.inheritedModel ? "（继承）" : ""}`}><span>{settings.model}</span>{settings.inheritedModel && <em>继承</em>}</code>
      <span className="subagent-effort" title={`Reasoning effort：${settings.reasoning}${settings.inheritedReasoning ? "（继承）" : ""}`}><Brain size={12} />{settings.reasoning}{settings.inheritedReasoning && <em>继承</em>}</span>
    </div>
    <span className="subagent-state">{statusLabel}</span>
  </div>;
}

export function SubagentStatusView({ parentThreadId, rootSettings, allAgents }: {
  parentThreadId: string;
  rootSettings: { model: string | null; reasoning: string | null };
  allAgents: SubagentRuntime[];
}) {
  const entries = useMemo(() => descendantSubagents(allAgents, parentThreadId), [allAgents, parentThreadId]);
  const agentsById = useMemo(() => new Map(allAgents.map((agent) => [agent.threadId, agent])), [allAgents]);
  const activeCount = entries.filter(({ agent }) => ACTIVE_STATES.has(displaySubagentState(agent))).length;
  const failedCount = entries.filter(({ agent }) => displaySubagentState(agent) === "failed").length;
  const summary = activeCount > 0
    ? `${activeCount} 运行中，共 ${entries.length} 个`
    : failedCount > 0 ? `${failedCount} 失败，共 ${entries.length} 个` : `${entries.length} 个`;
  return <Popover.Root><Popover.Trigger asChild><button
    className={`header-button subagent-trigger ${activeCount ? "has-active" : ""} ${failedCount ? "has-failed" : ""}`}
    type="button"
    aria-label={`Subagents，${summary}`}
    title={`Subagents，${summary}`}
  >
    <UsersThree size={16} />
    <span>Subagents</span>
    <strong>{activeCount || entries.length}</strong>
  </button></Popover.Trigger><Popover.Portal><Popover.Content className="popover-content subagent-popover" sideOffset={8} align="end">
    <header className="subagent-popover-header"><span><UsersThree size={17} /><strong>Subagents</strong></span><small>{summary}</small></header>
    {entries.length
      ? <div className="subagent-list" role="list">{entries.map(({ agent, nestingDepth }) => <SubagentAgentRow key={agent.threadId} agent={agent} nestingDepth={nestingDepth} agentsById={agentsById} rootSettings={rootSettings} />)}</div>
      : <p className="subagent-empty">当前 Session 没有 Subagent</p>}
  </Popover.Content></Popover.Portal></Popover.Root>;
}

export function SubagentStatus({ parentThreadId, rootSettings }: {
  parentThreadId: string;
  rootSettings: { model: string | null; reasoning: string | null };
}) {
  const subagentMap = useAppStore((state) => state.subagents);
  const allAgents = useMemo(() => Object.values(subagentMap), [subagentMap]);
  return <SubagentStatusView parentThreadId={parentThreadId} rootSettings={rootSettings} allAgents={allAgents} />;
}
