import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Alarm, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PromptSchedule as Schedule } from "@codex-web/shared-types";
import { api } from "../api";

export function PromptSchedule({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState("5");
  const [prompt, setPrompt] = useState("");
  const [autoStop, setAutoStop] = useState(false);
  const client = useQueryClient();
  const key = ["prompt-schedule", threadId];
  const url = `/api/sessions/${encodeURIComponent(threadId)}/schedule`;
  const query = useQuery({ queryKey: key, queryFn: () => api<Schedule | null>(url), refetchInterval: open ? 5000 : 30000 });
  const save = useMutation({
    mutationFn: (input: Pick<Schedule, "intervalMinutes" | "prompt" | "enabled" | "autoStop">) => api<Schedule>(url, { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: (value) => { client.setQueryData(key, value); },
  });
  const schedule = query.data;
  const valid = Number.isInteger(Number(minutes)) && Number(minutes) >= 1 && Number(minutes) <= 525600 && Boolean(prompt.trim());
  return <Popover.Root open={open} onOpenChange={(next) => {
    setOpen(next);
    if (next) { setMinutes(String(schedule?.intervalMinutes ?? 5)); setPrompt(schedule?.prompt ?? ""); setAutoStop(schedule?.autoStop ?? false); save.reset(); }
  }}>
    <Popover.Trigger asChild><button type="button" className={`schedule-trigger ${schedule?.enabled ? "active" : ""}`} disabled={query.isPending} aria-label="定时轮询" title="定时轮询"><Alarm size={18} weight={schedule?.enabled ? "fill" : "regular"} />{schedule?.enabled && <span>每 {schedule.intervalMinutes} 分钟</span>}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="schedule-panel" side="top" align="end" sideOffset={12} collisionPadding={14} aria-label="定时轮询设置">
      <div className="schedule-heading"><Alarm size={20} /><h2>定时轮询</h2><span className="schedule-state">{schedule?.enabled ? "已启用" : "未启用"}</span><Popover.Close className="icon-only" aria-label="关闭定时轮询设置"><X size={16} /></Popover.Close></div>
      <p className="dialog-description">服务器定时向当前任务发送 prompt，关闭浏览器后仍会继续。</p>
      {query.isPending ? <p role="status">正在读取设置…</p> : query.isError ? <p role="alert">读取失败：{query.error.message}<button onClick={() => void query.refetch()}>重试</button></p> : <form onSubmit={(event) => { event.preventDefault(); if (valid) save.mutate({ intervalMinutes: Number(minutes), prompt: prompt.trim(), enabled: true, autoStop }); }}>
        <div className="schedule-options"><label className="field-label">轮询间隔<div className="schedule-interval"><input type="number" min="1" max="525600" step="1" required value={minutes} onChange={(event) => setMinutes(event.target.value)} /><span>分钟</span></div></label><button className="schedule-auto-stop" type="button" role="switch" aria-checked={autoStop} aria-label="完成后自动暂停" onClick={() => setAutoStop(!autoStop)}><span>完成后自动暂停</span><span className="schedule-switch-track" aria-hidden="true"><span /></span></button></div>
        <label className="field-label">Prompt<textarea rows={5} maxLength={32000} required placeholder="检查任务进展，汇报新的结果或需要我处理的问题。" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
        <div className="schedule-status" role="status">{autoStop && <div>开启后，发送时会在 Prompt 末尾追加完成确认语句；回复包含指定句子时自动暂停。</div>}{schedule?.enabled && schedule.nextRunAt ? <div>下次执行 · {new Date(schedule.nextRunAt).toLocaleString()}</div> : <div>启用后将在一个间隔后首次发送</div>}{schedule?.lastResult && <div>上次检查 · {schedule.lastResult}</div>}<div>任务运行中会跳过本次，不堆积消息。</div></div>
        {save.error && <p className="composer-error" role="alert">保存失败：{save.error.message}</p>}
        {save.isSuccess && <p className="schedule-saved" role="status">设置已保存</p>}
        <div className="dialog-actions">{schedule?.enabled && <button className="button secondary" type="button" disabled={save.isPending} onClick={() => save.mutate({ intervalMinutes: schedule.intervalMinutes, prompt: schedule.prompt, enabled: false, autoStop: schedule.autoStop ?? false })}>暂停轮询</button>}<button className="button primary" type="submit" disabled={!valid || save.isPending}>{save.isPending ? "保存中…" : schedule?.enabled ? "保存修改" : "启用轮询"}</button></div>
      </form>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
