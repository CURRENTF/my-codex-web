import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, CaretDown, ShieldCheck, Square, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AccessMode, ModelOption, Project, RuntimeState } from "@codex-web/shared-types";
import { api, ApiError } from "../api";
import { useAppStore } from "../store";

function requestId(): string { return crypto.randomUUID(); }

export function Composer({ threadId, project, models, runtimeState, activeTurnId, initialSettings, compact = false }: {
  threadId: string; project: Project; models: ModelOption[]; runtimeState: RuntimeState; activeTurnId?: string;
  initialSettings: { model: string | null; reasoning: string | null; accessMode: AccessMode }; compact?: boolean;
}) {
  const queryClient = useQueryClient(); const textarea = useRef<HTMLTextAreaElement>(null);
  const draft = useAppStore((state) => state.drafts[threadId] ?? ""); const setDraft = useAppStore((state) => state.setDraft);
  const [model, setModel] = useState(initialSettings.model ?? project.defaultModel ?? models.find((item) => item.isDefault)?.model ?? models[0]?.model ?? "");
  const selectedModel = useMemo(() => models.find((item) => item.model === model || item.id === model), [models, model]);
  const [reasoning, setReasoning] = useState(initialSettings.reasoning ?? project.defaultReasoning ?? selectedModel?.defaultReasoning ?? "");
  const [accessMode, setAccessMode] = useState<AccessMode>(initialSettings.accessMode ?? project.defaultAccessMode);
  const [race, setRace] = useState(false); const running = runtimeState === "running" || runtimeState === "waitingForInput";
  useEffect(() => { if (selectedModel && !selectedModel.supportedReasoning.some((item) => item.effort === reasoning)) setReasoning(selectedModel.defaultReasoning); }, [selectedModel, reasoning]);
  const send = useMutation({ mutationFn: async ({ forceTurn = false }: { forceTurn?: boolean } = {}) => {
    const text = draft.trim(); if (!text) return;
    const clientRequestId = requestId(); const clientUserMessageId = requestId();
    if (running && activeTurnId && !forceTurn) {
      return api(`/api/sessions/${threadId}/steer`, { method: "POST", body: JSON.stringify({ text, expectedTurnId: activeTurnId, clientRequestId, clientUserMessageId }) });
    }
    return api(`/api/sessions/${threadId}/turns`, { method: "POST", body: JSON.stringify({ text, model, reasoning, accessMode, clientRequestId, clientUserMessageId }) });
  }, onSuccess: () => { setDraft(threadId, ""); setRace(false); void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] }); }, onError: (error) => { if (error instanceof ApiError && error.status === 409) setRace(true); } });
  const interrupt = useMutation({ mutationFn: () => api(`/api/sessions/${threadId}/interrupt`, { method: "POST" }) });
  const submit = () => { if (!send.isPending && draft.trim()) send.mutate({}); };
  return <div className={`composer-wrap ${compact ? "compact" : ""}`}>{race && <div className="composer-race"><WarningCircle size={16} weight="fill" /><span>当前执行刚刚结束</span><button onClick={() => send.mutate({ forceTurn: true })}>作为下一条消息发送</button><button onClick={() => { setRace(false); textarea.current?.focus(); }}>继续编辑</button></div>}
    <div className={`composer ${running ? "steer-mode" : ""}`}>
      <textarea ref={textarea} value={draft} rows={2} onChange={(event) => setDraft(threadId, event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} placeholder={running ? "向当前执行追加指令" : "要求后续变更"} />
      <div className="composer-toolbar"><div className="access-control"><ShieldCheck size={16} weight={accessMode === "fullAccess" ? "fill" : "regular"} /><select value={accessMode} onChange={(event) => setAccessMode(event.target.value as AccessMode)} disabled={running}><option value="fullAccess">Full Access</option><option value="workspaceWrite">Workspace Write</option><option value="readOnly">Read Only</option></select><CaretDown size={11} /></div><span className="toolbar-spacer" />
        <label className="inline-select"><select value={model} onChange={(event) => setModel(event.target.value)} disabled={running}>{models.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}</select><CaretDown size={11} /></label>
        <label className="inline-select reasoning-select"><select value={reasoning} onChange={(event) => setReasoning(event.target.value)} disabled={running}>{selectedModel?.supportedReasoning.map((item) => <option key={item.effort} value={item.effort}>{item.effort}</option>)}</select><CaretDown size={11} /></label>
        {running && <button className="stop-button" onClick={() => interrupt.mutate()} disabled={interrupt.isPending} aria-label="停止"><Square size={13} weight="fill" /></button>}
        <button className="send-button" onClick={submit} disabled={!draft.trim() || send.isPending || (running && !activeTurnId)} aria-label={running ? "Steer 当前 Turn" : "发送"}><ArrowUp size={17} weight="bold" /></button>
      </div>
    </div>{send.error && !race && <p className="composer-error">{send.error.message}</p>}</div>;
}
