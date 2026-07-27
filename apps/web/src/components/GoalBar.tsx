import { useEffect, useState } from "react";
import { Check, Flag, Pause, Plus, Trash } from "@phosphor-icons/react";
import * as Popover from "@radix-ui/react-popover";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, newClientRequestId, type Goal } from "../api";
import { goalUpdateInput } from "../goal-update";

function formatTokens(value: number): string { return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}k` : String(value); }

export function GoalBar({ threadId, goal, disabled = false }: { threadId: string; goal: Goal | null; disabled?: boolean }) {
  const queryClient = useQueryClient(); const [open, setOpen] = useState(false);
  const [objective, setObjective] = useState(goal?.objective ?? ""); const [budget, setBudget] = useState(goal?.tokenBudget?.toString() ?? ""); const [status, setStatus] = useState(goal?.status ?? "active");
  useEffect(() => { setObjective(goal?.objective ?? ""); setBudget(goal?.tokenBudget?.toString() ?? ""); setStatus(goal?.status ?? "active"); }, [goal]);
  const save = useMutation({ mutationFn: () => api(`/api/sessions/${threadId}/goal`, { method: "PUT", body: JSON.stringify({ ...goalUpdateInput(goal, objective.trim(), budget ? Number(budget) : null, status), clientRequestId: newClientRequestId() }) }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); setOpen(false); } });
  const clear = useMutation({ mutationFn: () => api(`/api/sessions/${threadId}/goal`, { method: "DELETE", body: JSON.stringify({ clientRequestId: newClientRequestId() }) }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); setOpen(false); } });
  return <Popover.Root open={open} onOpenChange={setOpen}><Popover.Trigger asChild><button className={`goal-bar ${goal ? "has-goal" : ""}`} disabled={disabled}>
    {goal ? <><Flag size={15} weight="fill" /><span className="goal-objective"><strong>Goal</strong><span>{goal.objective}</span></span><span className="goal-stats">{formatTokens(goal.tokensUsed)} / {goal.tokenBudget ? formatTokens(goal.tokenBudget) : "∞"} tokens<span aria-hidden>·</span>{goal.status}</span></> : <><Plus size={15} weight="bold" />设置 Goal</>}
  </button></Popover.Trigger><Popover.Portal><Popover.Content className="popover-content goal-popover" sideOffset={8} align="start">
    <div className="popover-heading"><Flag size={17} weight="fill" /><span>Session Goal</span></div>
    <label className="field-label">Objective<textarea rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="描述需要持续推进的目标" /></label>
    {goal && objective !== goal.objective && <p className="field-hint">修改 Objective 会重置使用统计。</p>}
    <div className="goal-form-row"><label className="field-label">Token Budget<input type="number" min="1" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="不限" /></label><label className="field-label">Status<select value={status} onChange={(event) => setStatus(event.target.value as Goal["status"])}><option value="active">Active</option><option value="paused">Paused</option><option value="blocked">Blocked</option><option value="usageLimited">Usage Limited</option><option value="budgetLimited">Budget Limited</option><option value="complete">Complete</option></select></label></div>
    {(save.isError || clear.isError) && <p className="dialog-error">Goal 更新失败：{(save.error ?? clear.error)?.message}</p>}
    <div className="popover-actions">{goal && <button className="button danger-ghost" onClick={() => clear.mutate()} disabled={clear.isPending}><Trash size={14} />清除</button>}<span /><button className="button secondary" onClick={() => setOpen(false)}>取消</button><button className="button primary" disabled={!objective.trim() || save.isPending} onClick={() => save.mutate()}>{status === "complete" ? <Check size={14} /> : status === "paused" ? <Pause size={14} /> : null}保存</button></div>
  </Popover.Content></Popover.Portal></Popover.Root>;
}
