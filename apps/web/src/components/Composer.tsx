import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, CaretDown, ShieldCheck, Square, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AccessMode, ModelOption, Project, RuntimeState } from "@codex-web/shared-types";
import { ApiError, api, newClientRequestId } from "../api";
import { expectedSteerTurnId, isTurnFinishedConflict } from "../composer-intent";
import { refreshProjectAvailabilityAfterError } from "../project-refresh";
import { useAppStore } from "../store";

function requestId(): string { return crypto.randomUUID(); }
function apiErrorCode(error: unknown): unknown {
  return error instanceof ApiError && error.body && typeof error.body === "object" && "error" in error.body
    ? (error.body as { error?: unknown }).error
    : undefined;
}

export function Composer({ threadId, project, models, runtimeState, activeTurnId, uncertainTurnStart = false, initialSettings, compact = false, disabled = false, onTextareaReady, onAccessModeChange }: {
  threadId: string; project: Project; models: ModelOption[]; runtimeState: RuntimeState; activeTurnId?: string;
  uncertainTurnStart?: boolean;
  initialSettings: { model: string | null; reasoning: string | null; accessMode: AccessMode }; compact?: boolean; disabled?: boolean; onTextareaReady?(element: HTMLTextAreaElement | null): void;
  onAccessModeChange?(accessMode: AccessMode): void;
}) {
  const queryClient = useQueryClient(); const textarea = useRef<HTMLTextAreaElement>(null);
  const bindTextarea = useCallback((element: HTMLTextAreaElement | null) => { textarea.current = element; onTextareaReady?.(element); }, [onTextareaReady]);
  const steerDraftTurnId = useRef<string | null>(null);
  const draft = useAppStore((state) => state.drafts[threadId] ?? ""); const setDraft = useAppStore((state) => state.setDraft);
  const pendingSubmission = useAppStore((state) => state.pendingSubmissions[threadId]);
  const beginSubmission = useAppStore((state) => state.beginSubmission);
  const acceptSubmission = useAppStore((state) => state.acceptSubmission);
  const markSubmissionUncertain = useAppStore((state) => state.markSubmissionUncertain);
  const markSubmissionRetryReady = useAppStore((state) => state.markSubmissionRetryReady);
  const finishSubmission = useAppStore((state) => state.finishSubmission);
  const [model, setModel] = useState(initialSettings.model ?? project.defaultModel ?? models.find((item) => item.isDefault)?.model ?? models[0]?.model ?? "");
  const selectedModel = useMemo(() => models.find((item) => item.model === model || item.id === model), [models, model]);
  const [reasoning, setReasoning] = useState(initialSettings.reasoning ?? project.defaultReasoning ?? selectedModel?.defaultReasoning ?? "");
  const [accessMode, setAccessMode] = useState<AccessMode>(initialSettings.accessMode ?? project.defaultAccessMode);
  const [race, setRace] = useState(false); const [resolutionMessage, setResolutionMessage] = useState<string | null>(null);
  const running = runtimeState === "running" || runtimeState === "waitingForInput"; const disconnected = runtimeState === "disconnected"; const blocked = (disabled || disconnected) && !running;
  const blockedMessage = disabled ? "Project 目录不可用；恢复该目录后重新扫描即可继续。" : "Session 尚未完成重同步；请等待状态恢复后继续。";
  useEffect(() => {
    const nextModel = initialSettings.model ?? project.defaultModel ?? models.find((item) => item.isDefault)?.model ?? models[0]?.model ?? "";
    const option = models.find((item) => item.model === nextModel || item.id === nextModel);
    setModel(nextModel);
    setReasoning(initialSettings.reasoning ?? project.defaultReasoning ?? option?.defaultReasoning ?? "");
    setAccessMode(initialSettings.accessMode ?? project.defaultAccessMode);
    steerDraftTurnId.current = null;
    setRace(false);
    setResolutionMessage(null);
  }, [threadId, initialSettings.model, initialSettings.reasoning, initialSettings.accessMode, project.defaultModel, project.defaultReasoning, project.defaultAccessMode, models]);
  useEffect(() => { if (selectedModel && !selectedModel.supportedReasoning.some((item) => item.effort === reasoning)) setReasoning(selectedModel.defaultReasoning); }, [selectedModel, reasoning]);
  const send = useMutation({ mutationFn: async ({ forceTurn = false, expectedTurnId }: { forceTurn?: boolean; expectedTurnId?: string | null } = {}) => {
    const submittedDraft = draft; const text = submittedDraft.trim(); if (!text) return;
    const clientRequestId = requestId();
    const retry = !forceTurn && !expectedTurnId && pendingSubmission?.state === "retryReady" && pendingSubmission.draft === submittedDraft;
    const clientUserMessageId = retry ? pendingSubmission.clientUserMessageId : requestId();
    beginSubmission(threadId, submittedDraft, clientUserMessageId);
    if (expectedTurnId && !forceTurn) {
      return api(`/api/sessions/${threadId}/steer`, { method: "POST", body: JSON.stringify({ text, expectedTurnId, clientRequestId, clientUserMessageId }) });
    }
    return api(`/api/sessions/${threadId}/turns`, { method: "POST", body: JSON.stringify({ text, model, reasoning, accessMode, clientRequestId, clientUserMessageId }) });
  }, onSuccess: () => { steerDraftTurnId.current = null; acceptSubmission(threadId); setRace(false); setResolutionMessage(null); void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] }); }, onError: (error) => {
    void queryClient.invalidateQueries({ queryKey: ["session", threadId] });
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    if (apiErrorCode(error) === "operation_uncertain") {
      markSubmissionUncertain(threadId);
      return;
    }
    finishSubmission(threadId, false);
    if (isTurnFinishedConflict(error)) {
      setRace(true);
      return;
    }
    void refreshProjectAvailabilityAfterError(error, (queryKey) => queryClient.invalidateQueries({ queryKey }));
  } });
  const resolveUncertainTurn = useMutation({
    mutationFn: () => api<{ status: "notApplied" | "alreadyResolved"; clientUserMessageId?: string; draft?: string }>(`/api/sessions/${threadId}/resolve-uncertain-turn`, {
      method: "POST",
      body: JSON.stringify({ clientRequestId: newClientRequestId() }),
    }),
    onSuccess: (result) => {
      send.reset();
      if (result.status === "notApplied") {
        if (result.draft && !pendingSubmission) {
          setDraft(threadId, result.draft);
          beginSubmission(threadId, result.draft, result.clientUserMessageId ?? requestId());
        }
        markSubmissionRetryReady(threadId, result.clientUserMessageId);
      }
      setResolutionMessage(result.status === "notApplied"
        ? "当前快照未发现先前请求；再次发送将复用原消息 ID，避免迟到请求造成重复 Turn。"
        : "Codex 已先一步更新该 Session；请查看 Timeline，草稿未重复发送。");
      void queryClient.invalidateQueries({ queryKey: ["session", threadId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      textarea.current?.focus();
    },
    onError: (error) => {
      send.reset();
      const code = apiErrorCode(error);
      if (code === "uncertain_turn_applied") finishSubmission(threadId, true);
      setResolutionMessage(code === "uncertain_turn_applied"
        ? "先前请求已出现在 Session 中，未重复发送；请查看 Timeline。"
        : `无法确认先前请求状态：${error.message}`);
      void queryClient.invalidateQueries({ queryKey: ["session", threadId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const interrupt = useMutation({ mutationFn: () => api(`/api/sessions/${threadId}/interrupt`, { method: "POST", body: JSON.stringify({ clientRequestId: newClientRequestId() }) }) });
  const rememberSteerIntent = () => { if (running && activeTurnId) steerDraftTurnId.current ??= activeTurnId; };
  const submit = () => {
    if (blocked || send.isPending || !draft.trim()) return;
    const expectedTurnId = expectedSteerTurnId(steerDraftTurnId.current, running, activeTurnId);
    send.mutate({ expectedTurnId });
  };
  return <div className={`composer-wrap ${compact ? "compact" : ""}`}>{race && <div className="composer-race"><WarningCircle size={16} weight="fill" /><span>当前执行刚刚结束</span><button onClick={() => send.mutate({ forceTurn: true })}>作为下一条消息发送</button><button onClick={() => { steerDraftTurnId.current = null; setRace(false); textarea.current?.focus(); }}>继续编辑</button></div>}
    {uncertainTurnStart && <div className="composer-race uncertain-turn"><WarningCircle size={16} weight="fill" /><span>Codex 未确认上一条消息是否开始执行。为避免重复任务，请先显式核实；当前草稿不会丢失。</span><button disabled={resolveUncertainTurn.isPending} onClick={() => resolveUncertainTurn.mutate()}>{resolveUncertainTurn.isPending ? "正在核实…" : "确认未执行，恢复输入"}</button></div>}
    <div className={`composer ${running ? "steer-mode" : ""}`}>
      <textarea ref={bindTextarea} value={draft} rows={2} disabled={blocked} onChange={(event) => { rememberSteerIntent(); setResolutionMessage(null); setDraft(threadId, event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); rememberSteerIntent(); submit(); } }} placeholder={uncertainTurnStart ? "请先核实上一条消息是否执行" : disconnected ? "Session 正在重新同步" : blocked ? "Project 目录不可用" : running ? "向当前执行追加指令" : "要求后续变更"} />
      <div className="composer-toolbar"><div className="access-control"><ShieldCheck size={16} weight={accessMode === "fullAccess" ? "fill" : "regular"} /><select value={accessMode} onChange={(event) => { const next = event.target.value as AccessMode; setAccessMode(next); onAccessModeChange?.(next); }} disabled={running || blocked}><option value="fullAccess">Full Access</option><option value="workspaceWrite">Workspace Write</option><option value="readOnly">Read Only</option></select><CaretDown size={11} /></div><span className="toolbar-spacer" />
        <label className="inline-select"><select value={model} onChange={(event) => setModel(event.target.value)} disabled={running || blocked}>{models.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}</select><CaretDown size={11} /></label>
        <label className="inline-select reasoning-select"><select value={reasoning} onChange={(event) => setReasoning(event.target.value)} disabled={running || blocked}>{selectedModel?.supportedReasoning.map((item) => <option key={item.effort} value={item.effort}>{item.effort}</option>)}</select><CaretDown size={11} /></label>
        {running && <button className="stop-button" onClick={() => interrupt.mutate()} disabled={interrupt.isPending} aria-label="停止"><Square size={13} weight="fill" /></button>}
        <button className="send-button" onPointerDown={rememberSteerIntent} onClick={submit} disabled={blocked || !draft.trim() || send.isPending || (running && !activeTurnId)} aria-label={running ? "Steer 当前 Turn" : "发送"}><ArrowUp size={17} weight="bold" /></button>
      </div>
    </div>{blocked && !uncertainTurnStart && <p className="composer-error">{blockedMessage}</p>}{resolutionMessage && <p className={resolutionMessage.startsWith("无法") ? "composer-error" : "composer-resolution"}>{resolutionMessage}</p>}{send.error && !race && !uncertainTurnStart && !resolutionMessage && <p className="composer-error">{send.error.message}</p>}{interrupt.error && <p className="composer-error">{interrupt.error.message}</p>}</div>;
}
