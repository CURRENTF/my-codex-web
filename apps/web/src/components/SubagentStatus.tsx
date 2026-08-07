import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, CaretRight, GitFork, UsersThree } from "@phosphor-icons/react";
import type { SubagentRuntime } from "@codex-web/shared-types";
import { useAppStore } from "../store";
import { descendantSubagents, displaySubagentState, effectiveSubagentSettings, subagentContextLabel, subagentDisplayName, subagentStateLabel } from "../subagent-presentation";
import { StatusIcon } from "./StatusIcon";

const ACTIVE_STATES = new Set(["running", "waitingForInput"]);

function AgentRow({ agent, nestingDepth, agentsById, rootSettings }: {
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
  const [open, setOpen] = useState(activeCount > 0);
  const previousActiveCount = useRef(activeCount);
  useEffect(() => { setOpen(activeCount > 0); previousActiveCount.current = activeCount; }, [parentThreadId]);
  useEffect(() => {
    if (previousActiveCount.current === 0 && activeCount > 0) setOpen(true);
    previousActiveCount.current = activeCount;
  }, [activeCount]);
  if (!entries.length) return null;
  return <section className={`subagent-status ${activeCount ? "has-active" : ""}`} aria-label="Subagent 状态">
    <button className="subagent-summary" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <CaretRight className="subagent-caret" size={13} weight="bold" />
      <UsersThree size={16} />
      <strong>Subagents</strong>
      {activeCount > 0 ? <span className="subagent-summary-primary">{activeCount} 运行中</span> : <span>{entries.length} 个</span>}
      {failedCount > 0 && <span className="subagent-summary-failed">{failedCount} 失败</span>}
      <span className="subagent-summary-spacer" />
      <span>{open ? "收起" : "查看详情"}</span>
    </button>
    {open && <div className="subagent-list" role="list">{entries.map(({ agent, nestingDepth }) => <AgentRow key={agent.threadId} agent={agent} nestingDepth={nestingDepth} agentsById={agentsById} rootSettings={rootSettings} />)}</div>}
  </section>;
}

export function SubagentStatus({ parentThreadId, rootSettings }: {
  parentThreadId: string;
  rootSettings: { model: string | null; reasoning: string | null };
}) {
  const subagentMap = useAppStore((state) => state.subagents);
  const allAgents = useMemo(() => Object.values(subagentMap), [subagentMap]);
  return <SubagentStatusView parentThreadId={parentThreadId} rootSettings={rootSettings} allAgents={allAgents} />;
}
