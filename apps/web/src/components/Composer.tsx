import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ClockCounterClockwise, Command, Cube, File as FileIcon, Lightning, Paperclip, ShieldCheck, SpinnerGap, Square, WarningCircle, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccessMode, ContextUsage, Goal, ModelOption, Project, RuntimeState, SessionTurn, SkillOption, UploadedAttachment } from "@codex-web/shared-types";
import { ApiError, api, endpoints, newClientRequestId } from "../api";
import { commandArgumentSuggestions, composerTrigger, isCompletedSkillTrigger, isSupportedSlashCommand, parseSlashCommand, referencedSkillNames, slashArgumentTrigger, slashCommands, type CompletedSkillMention, type SlashCommandName } from "../composer-commands";
import { expectedSteerTurnId, isTurnFinishedConflict } from "../composer-intent";
import { resizeComposerTextarea } from "../composer-textarea";
import { refreshProjectAvailabilityAfterError } from "../project-refresh";
import { advanceQueuedTurnBarrier, isQueuedTimelineSettled, type QueuedTurnBarrier } from "../queued-turn-barrier";
import { fastServiceTierForModel, serviceTierForModel } from "../service-tier";
import { useAppStore, type QueuedMessageSettings, type QueuedSubmission } from "../store";
import { SettingsSelect } from "./SettingsSelect";

function requestId(): string { return crypto.randomUUID(); }
function apiErrorCode(error: unknown): unknown {
  return error instanceof ApiError && error.body && typeof error.body === "object" && "error" in error.body
    ? (error.body as { error?: unknown }).error
    : undefined;
}

type Feedback = { tone: "success" | "error" | "info"; text: string };
type MenuOption = { key: string; value: string; label: string; description?: string; meta?: string };
type MenuState = { kind: "command" | "skill" | "argument"; options: MenuOption[]; title: string; hint: string };
type DeliveryMode = "steer" | "queue";
type SlashCommandExecutionResult = { turnId?: string; queuedSettings?: QueuedMessageSettings };

const MAX_ATTACHMENTS = 10;

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.ceil(bytes / 1_024)} KiB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MiB`;
}

function preferredReasoningForModel(model: ModelOption | undefined): string {
  return model?.supportedReasoning.find((item) => item.effort === "high")?.effort ?? model?.defaultReasoning ?? "";
}

function reasoningLabel(effort: string): string {
  return effort ? effort[0]!.toLocaleUpperCase() + effort.slice(1) : "Reasoning";
}

function accessModeLabel(mode: AccessMode): string {
  if (mode === "fullAccess") return "Full Access";
  if (mode === "workspaceWrite") return "Workspace Write";
  return "Read Only";
}

function normalizeAccessMode(value: string): AccessMode | null {
  const normalized = value.trim().toLocaleLowerCase().replace(/[ _-]/g, "");
  if (normalized === "full" || normalized === "fullaccess") return "fullAccess";
  if (normalized === "workspace" || normalized === "workspacewrite") return "workspaceWrite";
  if (normalized === "read" || normalized === "readonly") return "readOnly";
  return null;
}

export function Composer({ threadId, project, models, runtimeState, activeTurnId, uncertainTurnStart = false, initialSettings, goal = null, contextUsage, latestCompletedTurnId = null, latestTurnId = null, latestTurnStatus = null, compact = false, disabled = false, onTextareaReady, onAccessModeChange, onForkLatest, onOpenSideChat }: {
  threadId: string; project: Project; models: ModelOption[]; runtimeState: RuntimeState; activeTurnId?: string;
  uncertainTurnStart?: boolean;
  initialSettings: { model: string | null; reasoning: string | null; serviceTier: string | null; accessMode: AccessMode };
  goal?: Goal | null; contextUsage?: ContextUsage; latestCompletedTurnId?: string | null; latestTurnId?: string | null; latestTurnStatus?: SessionTurn["status"] | null;
  compact?: boolean; disabled?: boolean; onTextareaReady?(element: HTMLTextAreaElement | null): void;
  onAccessModeChange?(accessMode: AccessMode): void; onForkLatest?(clientRequestId: string): Promise<boolean>; onOpenSideChat?(clientRequestId: string): Promise<boolean>;
}) {
  const queryClient = useQueryClient(); const textarea = useRef<HTMLTextAreaElement>(null); const fileInput = useRef<HTMLInputElement>(null);
  const bindTextarea = useCallback((element: HTMLTextAreaElement | null) => { textarea.current = element; onTextareaReady?.(element); }, [onTextareaReady]);
  const steerDraftTurnId = useRef<string | null>(null);
  const submittedAttachmentIds = useRef<string[]>([]);
  const draft = useAppStore((state) => state.drafts[threadId] ?? ""); const setDraft = useAppStore((state) => state.setDraft);
  const pendingSubmission = useAppStore((state) => state.pendingSubmissions[threadId]);
  const beginSubmission = useAppStore((state) => state.beginSubmission);
  const acceptSubmission = useAppStore((state) => state.acceptSubmission);
  const markSubmissionUncertain = useAppStore((state) => state.markSubmissionUncertain);
  const markSubmissionRetryReady = useAppStore((state) => state.markSubmissionRetryReady);
  const finishSubmission = useAppStore((state) => state.finishSubmission);
  const storedQueuedSubmissions = useAppStore((state) => state.queuedSubmissions[threadId]);
  const queuedEffectiveSettings = useAppStore((state) => state.queuedEffectiveSettings[threadId]);
  const queuedTurnBarrier = useAppStore((state) => state.queuedTurnBarriers[threadId] ?? null);
  const queuedSubmissions = storedQueuedSubmissions ?? [];
  const queuedSubmission = queuedSubmissions[0];
  const queuedUserMessage = queuedSubmission?.kind === "message" ? queuedSubmission : undefined;
  const enqueueSubmission = useAppStore((state) => state.enqueueSubmission);
  const applyQueuedSettings = useAppStore((state) => state.applyQueuedSettings);
  const setStoredQueuedTurnBarrier = useAppStore((state) => state.setQueuedTurnBarrier);
  const removeQueuedSubmission = useAppStore((state) => state.removeQueuedSubmission);
  const initialModel = queuedEffectiveSettings?.model ?? initialSettings.model ?? project.defaultModel ?? models.find((item) => item.isDefault)?.model ?? models[0]?.model ?? "";
  const [model, setModel] = useState(initialModel);
  const selectedModel = useMemo(() => models.find((item) => item.model === model || item.id === model), [models, model]);
  const [reasoning, setReasoning] = useState(queuedEffectiveSettings?.reasoning ?? initialSettings.reasoning ?? project.defaultReasoning ?? preferredReasoningForModel(selectedModel));
  const [serviceTier, setServiceTier] = useState<string | null>(queuedEffectiveSettings ? queuedEffectiveSettings.serviceTier : serviceTierForModel(selectedModel, initialSettings.serviceTier));
  const [accessMode, setAccessMode] = useState<AccessMode>(queuedEffectiveSettings?.accessMode ?? initialSettings.accessMode ?? project.defaultAccessMode);
  const effectiveSettings = useRef<QueuedMessageSettings>({ model, reasoning, serviceTier, accessMode });
  effectiveSettings.current = { model, reasoning, serviceTier, accessMode };
  const [resolutionMessage, setResolutionMessage] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null); const [cursor, setCursor] = useState(0);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("steer");
  const [menuIndex, setMenuIndex] = useState(0); const [dismissedMenuDraft, setDismissedMenuDraft] = useState<string | null>(null);
  const [completedSkillMention, setCompletedSkillMention] = useState<CompletedSkillMention | null>(null);
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [queuedCommandPendingId, setQueuedCommandPendingId] = useState<string | null>(null);
  const attachmentThread = useRef(threadId);
  const running = runtimeState === "running" || runtimeState === "waitingForInput"; const disconnected = runtimeState === "disconnected"; const blocked = (disabled || disconnected) && !running;
  const blockedMessage = disabled ? "Project 目录不可用；恢复该目录后重新扫描即可继续。" : "Session 尚未完成重同步；请等待状态恢复后继续。";
  const skills = useQuery({ queryKey: ["skills", project.id], queryFn: ({ signal }) => endpoints.skills(project.id, signal), enabled: project.available && !disconnected, staleTime: 60_000 });

  useEffect(() => {
    attachmentThread.current = threadId;
    const nextModel = queuedEffectiveSettings?.model ?? initialSettings.model ?? project.defaultModel ?? models.find((item) => item.isDefault)?.model ?? models[0]?.model ?? "";
    const option = models.find((item) => item.model === nextModel || item.id === nextModel);
    const nextReasoning = queuedEffectiveSettings?.reasoning ?? initialSettings.reasoning ?? project.defaultReasoning ?? preferredReasoningForModel(option);
    const nextServiceTier = queuedEffectiveSettings ? queuedEffectiveSettings.serviceTier : serviceTierForModel(option, initialSettings.serviceTier);
    const nextAccessMode = queuedEffectiveSettings?.accessMode ?? initialSettings.accessMode ?? project.defaultAccessMode;
    effectiveSettings.current = { model: nextModel, reasoning: nextReasoning, serviceTier: nextServiceTier, accessMode: nextAccessMode };
    setModel(nextModel);
    setReasoning(nextReasoning);
    setServiceTier(nextServiceTier);
    setAccessMode(nextAccessMode);
    steerDraftTurnId.current = null;
    setResolutionMessage(null); setFeedback(null); setDismissedMenuDraft(null); setCompletedSkillMention(null); setCursor(0); setDeliveryMode("steer"); setAttachments([]); setUploadingCount(0); setDraggingFiles(false); setQueuedCommandPendingId(null);
  }, [threadId, initialSettings.model, initialSettings.reasoning, initialSettings.serviceTier, initialSettings.accessMode, project.defaultModel, project.defaultReasoning, project.defaultAccessMode, models]);
  useEffect(() => {
    if (!selectedModel || selectedModel.supportedReasoning.some((item) => item.effort === reasoning)) return;
    effectiveSettings.current = { ...effectiveSettings.current, reasoning: selectedModel.defaultReasoning };
    setReasoning(selectedModel.defaultReasoning);
  }, [selectedModel, reasoning]);
  useEffect(() => {
    setServiceTier((current) => {
      const next = serviceTierForModel(selectedModel, current);
      effectiveSettings.current = { ...effectiveSettings.current, serviceTier: next };
      return next;
    });
  }, [selectedModel]);
  const fastServiceTier = useMemo(() => fastServiceTierForModel(selectedModel), [selectedModel]);
  const fastMode = !!fastServiceTier && serviceTier === fastServiceTier.id;
  const modelSelectOptions = useMemo(() => models.map((item) => ({
    value: item.model,
    label: item.displayName,
    description: item.description,
    ...(item.isDefault ? { meta: "默认" } : {}),
  })), [models]);
  const reasoningSelectOptions = useMemo(() => (selectedModel?.supportedReasoning ?? []).map((item) => ({
    value: item.effort,
    label: reasoningLabel(item.effort),
    description: item.description,
    ...(item.effort === selectedModel?.defaultReasoning ? { meta: "默认" } : {}),
  })), [selectedModel]);
  useLayoutEffect(() => {
    if (textarea.current) resizeComposerTextarea(textarea.current);
  }, [draft]);
  useEffect(() => {
    const resize = () => { if (textarea.current) resizeComposerTextarea(textarea.current); };
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, []);

  const trigger = composerTrigger(draft, cursor);
  const argumentTrigger = slashArgumentTrigger(draft);
  const menu = useMemo<MenuState | null>(() => {
    if (dismissedMenuDraft === draft) return null;
    if (isCompletedSkillTrigger(draft, cursor, trigger, completedSkillMention)) return null;
    if (argumentTrigger) {
      const supplied = argumentTrigger.command === "model"
        ? models.map((item) => ({ value: item.model, label: item.displayName }))
        : argumentTrigger.command === "reasoning"
          ? (selectedModel?.supportedReasoning ?? []).map((item) => ({ value: item.effort, label: item.effort }))
          : [];
      const options = commandArgumentSuggestions(argumentTrigger.command, argumentTrigger.query, supplied).map((option) => ({ key: `${argumentTrigger.command}:${option.value}`, value: option.value, label: option.label }));
      return { kind: "argument", options, title: `/${argumentTrigger.command}`, hint: "Enter 选择 · Esc 关闭" };
    }
    if (trigger?.kind === "command") {
      const query = trigger.query.toLocaleLowerCase();
      const options = slashCommands.filter((command) => !query || command.name.includes(query) || command.description.toLocaleLowerCase().includes(query)).map((command) => ({ key: command.name, value: command.name, label: `/${command.name}`, description: command.description, meta: command.usage }));
      return { kind: "command", options, title: "Slash 命令", hint: running ? "Enter 补全 · Tab 将完整命令排到下一轮" : "Enter 补全 · Esc 关闭" };
    }
    if (trigger?.kind === "skill") {
      const query = trigger.query.trim().toLocaleLowerCase();
      const options = (skills.data ?? []).filter((skill) => !query || skill.name.toLocaleLowerCase().includes(query) || skill.description.toLocaleLowerCase().includes(query)).map((skill) => ({ key: skill.path, value: skill.name, label: `$${skill.name}`, description: skill.description, meta: skill.scope }));
      return { kind: "skill", options, title: "Skills", hint: skills.isLoading ? "正在载入…" : "Enter 插入结构化 Skill 引用" };
    }
    return null;
  }, [argumentTrigger, completedSkillMention, cursor, dismissedMenuDraft, draft, models, running, selectedModel?.supportedReasoning, skills.data, skills.isLoading, trigger]);
  const menuKey = menu ? `${menu.kind}:${menu.options.map((option) => option.key).join("|")}` : "";
  useEffect(() => setMenuIndex(0), [menuKey]);

  const updateDraft = useCallback((next: string, nextCursor = next.length, dismissMenu = false) => {
    setDraft(threadId, next); setCursor(nextCursor); setDismissedMenuDraft(dismissMenu ? next : null);
    window.requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(nextCursor, nextCursor); });
  }, [setDraft, threadId]);

  const uploadFiles = useCallback(async (files: readonly File[]) => {
    const remaining = MAX_ATTACHMENTS - attachments.length - uploadingCount;
    if (remaining <= 0) { setFeedback({ tone: "error", text: `每条消息最多添加 ${MAX_ATTACHMENTS} 个附件。` }); return; }
    const selected = [...files].slice(0, remaining);
    if (!selected.length) return;
    const targetThread = threadId;
    setUploadingCount((count) => count + selected.length); setFeedback(null);
    const results = await Promise.allSettled(selected.map((file) => endpoints.uploadAttachment(file)));
    const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (attachmentThread.current === targetThread) setAttachments((current) => [...current, ...uploaded].slice(0, MAX_ATTACHMENTS));
    else await Promise.all(uploaded.map((attachment) => endpoints.removeAttachment(attachment.id).catch(() => undefined)));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (attachmentThread.current === targetThread && failures.length) {
      const first = failures[0]; setFeedback({ tone: "error", text: `有 ${failures.length} 个附件上传失败：${first instanceof Error ? first.message : "未知错误"}` });
    }
    setUploadingCount((count) => Math.max(0, count - selected.length));
    if (fileInput.current) fileInput.current.value = "";
  }, [attachments.length, threadId, uploadingCount]);

  const removeAttachment = useCallback(async (attachment: UploadedAttachment) => {
    setAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id));
    try { await endpoints.removeAttachment(attachment.id); }
    catch (error) { setFeedback({ tone: "error", text: `删除附件失败：${error instanceof Error ? error.message : "未知错误"}` }); }
  }, []);

  const attachmentIds = attachments.map((attachment) => attachment.id);
  const hasPayload = draft.trim().length > 0 || attachments.length > 0;

  const persistAccessMode = useMutation({ mutationFn: (next: AccessMode) => api(`/api/sessions/${threadId}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ accessMode: next, clientRequestId: requestId() }),
  }) });

  const executeSlashCommand = useCallback(async (raw: string, clientRequestId = newClientRequestId()): Promise<SlashCommandExecutionResult> => {
    const parsed = parseSlashCommand(raw);
    if (!parsed || !isSupportedSlashCommand(parsed.name)) throw new Error(`不支持的 Slash 命令：/${parsed?.name ?? ""}`);
    const command = parsed.name as SlashCommandName; const args = parsed.args;
    if (command === "goal") {
      if (!args) {
        setFeedback({ tone: "info", text: goal ? `Goal · ${goal.status} · ${goal.objective} · ${goal.tokensUsed}/${goal.tokenBudget ?? "∞"} tokens` : "当前 Session 尚未设置 Goal。用 /goal <目标> 创建。" });
        return {};
      }
      if (args === "clear") {
        await api(`/api/sessions/${threadId}/goal`, { method: "DELETE", body: JSON.stringify({ clientRequestId }) });
        setFeedback({ tone: "success", text: "Goal 已清除。" });
      } else if (args === "pause" || args === "resume") {
        if (!goal) throw new Error("当前没有 Goal；请先用 /goal <目标> 创建。");
        const status = args === "pause" ? "paused" : "active";
        await api(`/api/sessions/${threadId}/goal`, { method: "PUT", body: JSON.stringify({ status, clientRequestId }) });
        setFeedback({ tone: "success", text: `Goal 已${status === "paused" ? "暂停" : "恢复"}。` });
      } else {
        const objective = args.startsWith("edit ") ? args.slice(5).trim() : args;
        if (!objective) throw new Error("Goal 内容不能为空。");
        await api(`/api/sessions/${threadId}/goal`, { method: "PUT", body: JSON.stringify({ objective, status: "active", clientRequestId }) });
        setFeedback({ tone: "success", text: `Goal 已设置：${objective}` });
      }
      await queryClient.invalidateQueries({ queryKey: ["session", threadId] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      return {};
    }
    if (command === "compact") {
      if (args) throw new Error("/compact 不接受参数。");
      await api(`/api/sessions/${threadId}/compact`, { method: "POST", body: JSON.stringify({ clientRequestId }) });
      setFeedback({ tone: "success", text: "上下文压缩已启动。" });
      return {};
    }
    if (command === "review") {
      const target = !args ? { type: "uncommittedChanges" as const }
        : args.startsWith("base ") ? { type: "baseBranch" as const, branch: args.slice(5).trim() }
          : args.startsWith("commit ") ? { type: "commit" as const, sha: args.slice(7).trim(), title: null }
            : { type: "custom" as const, instructions: args };
      if ((target.type === "baseBranch" && !target.branch) || (target.type === "commit" && !target.sha)) throw new Error("/review 参数不完整。");
      const result = await api<{ turn: { id: string } }>(`/api/sessions/${threadId}/review`, { method: "POST", body: JSON.stringify({ target, clientRequestId }) });
      setFeedback({ tone: "success", text: "Review 已启动。" });
      await queryClient.invalidateQueries({ queryKey: ["session", threadId] });
      return { turnId: result.turn.id };
    }
    if (command === "fork") {
      if (args) throw new Error("/fork 不接受参数。");
      if (!latestCompletedTurnId || !onForkLatest) throw new Error("当前没有可 Fork 的已完成 Turn。");
      if (!await onForkLatest(clientRequestId)) throw new Error("Fork 未完成；该命令仍保留在队列中。");
      setFeedback({ tone: "success", text: "已从最新完成位置创建 Fork。" }); return {};
    }
    if (command === "side") {
      if (args) throw new Error("/side 不接受参数。");
      if (!onOpenSideChat) throw new Error("当前视图不支持 Side Chat。");
      if (!await onOpenSideChat(clientRequestId)) throw new Error("Side Chat 创建失败；该命令仍保留在队列中。");
      setFeedback({ tone: "success", text: "Side Chat 已打开。" }); return {};
    }
    if (command === "model") {
      const option = models.find((item) => item.model === args || item.id === args);
      if (!option) throw new Error("请选择 /model 菜单中列出的模型。");
      const nextReasoning = preferredReasoningForModel(option);
      const nextServiceTier = serviceTierForModel(option, effectiveSettings.current.serviceTier);
      const queuedSettings = { ...effectiveSettings.current, model: option.model, reasoning: nextReasoning, serviceTier: nextServiceTier };
      effectiveSettings.current = queuedSettings;
      setModel(option.model); setReasoning(nextReasoning); setServiceTier(nextServiceTier); setFeedback({ tone: "success", text: `模型已切换为 ${option.displayName}；将在下一 Turn 生效。` }); return { queuedSettings };
    }
    if (command === "reasoning") {
      const effectiveModel = models.find((item) => item.model === effectiveSettings.current.model || item.id === effectiveSettings.current.model);
      if (!effectiveModel?.supportedReasoning.some((item) => item.effort === args)) throw new Error("请选择当前模型支持的 Reasoning 强度。");
      const queuedSettings = { ...effectiveSettings.current, reasoning: args };
      effectiveSettings.current = queuedSettings;
      setReasoning(args); setFeedback({ tone: "success", text: `Reasoning 已切换为 ${args}；将在下一 Turn 生效。` }); return { queuedSettings };
    }
    if (command === "permissions") {
      const next = normalizeAccessMode(args);
      if (!next) throw new Error("权限仅支持 fullAccess、workspaceWrite、readOnly。");
      await persistAccessMode.mutateAsync(next); const queuedSettings = { ...effectiveSettings.current, accessMode: next }; effectiveSettings.current = queuedSettings; setAccessMode(next); onAccessModeChange?.(next);
      setFeedback({ tone: "success", text: `权限已切换为 ${accessModeLabel(next)}。` }); return { queuedSettings };
    }
    if (command === "status") {
      if (args) throw new Error("/status 不接受参数。");
      const context = contextUsage ? `${contextUsage.usedTokens.toLocaleString()} / ${contextUsage.maxTokens?.toLocaleString() ?? "?"} tokens` : "尚无数据";
      setFeedback({ tone: "info", text: `${runtimeState} · ${selectedModel?.displayName ?? model} · ${fastMode ? "Fast" : "Standard"} · reasoning ${reasoning || "default"} · ${accessModeLabel(accessMode)} · 上下文 ${context}` }); return {};
    }
    updateDraft("$", 1); setFeedback(null); return {};
  }, [accessMode, contextUsage, fastMode, goal, latestCompletedTurnId, model, models, onAccessModeChange, onForkLatest, onOpenSideChat, persistAccessMode, queryClient, reasoning, runtimeState, selectedModel, threadId, updateDraft]);

  const send = useMutation({ mutationFn: async ({ expectedTurnId }: { expectedTurnId?: string | null } = {}) => {
    const submittedDraft = draft; const submittedAttachments = [...attachments]; const text = submittedDraft.trim(); if (!text && !submittedAttachments.length) return;
    const clientRequestId = requestId();
    const retry = !expectedTurnId && pendingSubmission?.state === "retryReady" && pendingSubmission.draft === submittedDraft;
    const clientUserMessageId = retry ? pendingSubmission.clientUserMessageId : requestId();
    const skillNames = referencedSkillNames(text, skills.data ?? []);
    submittedAttachmentIds.current = submittedAttachments.map((attachment) => attachment.id);
    beginSubmission(threadId, submittedDraft, clientUserMessageId, submittedAttachments);
    if (expectedTurnId) {
      try {
        return await api(`/api/sessions/${threadId}/steer`, { method: "POST", body: JSON.stringify({ text, skillNames, attachmentIds: submittedAttachments.map((attachment) => attachment.id), expectedTurnId, clientRequestId, clientUserMessageId }) });
      } catch (error) {
        if (!isTurnFinishedConflict(error)) throw error;
        steerDraftTurnId.current = null;
      }
    }
    return api(`/api/sessions/${threadId}/turns`, { method: "POST", body: JSON.stringify({ text, skillNames, attachmentIds: submittedAttachments.map((attachment) => attachment.id), model, reasoning, serviceTier, accessMode, clientRequestId: expectedTurnId ? requestId() : clientRequestId, clientUserMessageId }) });
  }, onSuccess: () => { const sent = new Set(submittedAttachmentIds.current); submittedAttachmentIds.current = []; steerDraftTurnId.current = null; acceptSubmission(threadId); setAttachments((current) => current.filter((attachment) => !sent.has(attachment.id))); setResolutionMessage(null); setFeedback(null); void queryClient.invalidateQueries({ queryKey: ["sessions"] }); }, onError: (error) => {
    void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    if (apiErrorCode(error) === "operation_uncertain") { markSubmissionUncertain(threadId); return; }
    finishSubmission(threadId, false);
    void refreshProjectAvailabilityAfterError(error, (queryKey) => queryClient.invalidateQueries({ queryKey }));
  } });

  const sendQueuedMessage = useMutation({ mutationFn: async (message: Extract<QueuedSubmission, { kind: "message" }>) => {
    beginSubmission(threadId, message.text, message.clientUserMessageId, message.attachments ?? []);
    return api<{ turn: { id: string } }>(`/api/sessions/${threadId}/turns`, {
      method: "POST",
      body: JSON.stringify({
        text: message.text,
        skillNames: message.skillNames,
        attachmentIds: (message.attachments ?? []).map((attachment) => attachment.id),
        model: message.model,
        reasoning: message.reasoning,
        serviceTier: message.serviceTier,
        accessMode: message.accessMode,
        clientRequestId: message.clientRequestId,
        clientUserMessageId: message.clientUserMessageId,
      }),
    });
  }, onSuccess: (result: { turn: { id: string } }, message) => {
    setStoredQueuedTurnBarrier(threadId, { clientRequestId: message.clientRequestId, previousLatestTurnId: latestTurnId, turnId: result.turn.id });
    acceptSubmission(threadId); removeQueuedSubmission(threadId, message.clientRequestId, true); setFeedback(null);
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
  }, onError: (error, message) => {
    if (apiErrorCode(error) === "operation_uncertain") {
      markSubmissionUncertain(threadId);
      setFeedback({ tone: "info", text: "排队需求的发送结果尚未确认；请先核实，系统不会自动重复发送。" });
      return;
    }
    finishSubmission(threadId, false, true); enqueueSubmission(threadId, message);
    setFeedback({ tone: "error", text: `排队需求发送失败：${error.message}` });
    void refreshProjectAvailabilityAfterError(error, (queryKey) => queryClient.invalidateQueries({ queryKey }));
  } });

  const resolveUncertainTurn = useMutation({
    mutationFn: () => api<{ status: "notApplied" | "alreadyResolved"; clientUserMessageId?: string; draft?: string; attachmentIds?: string[] }>(`/api/sessions/${threadId}/resolve-uncertain-turn`, { method: "POST", body: JSON.stringify({ clientRequestId: newClientRequestId() }) }),
    onSuccess: (result) => {
      send.reset();
      if (result.status === "notApplied") {
        if (queuedUserMessage) {
          removeQueuedSubmission(threadId, queuedUserMessage.clientRequestId);
          setDraft(threadId, result.draft ?? queuedUserMessage.text);
          setAttachments(queuedUserMessage.attachments ?? []);
          setDeliveryMode("steer");
        }
        if (result.draft && !pendingSubmission) { setDraft(threadId, result.draft); beginSubmission(threadId, result.draft, result.clientUserMessageId ?? requestId()); }
        markSubmissionRetryReady(threadId, result.clientUserMessageId);
      } else if (queuedUserMessage) {
        removeQueuedSubmission(threadId, queuedUserMessage.clientRequestId, true);
      }
      setResolutionMessage(result.status === "notApplied" ? "当前快照未发现先前请求；再次发送将复用原消息 ID，避免迟到请求造成重复 Turn。" : "Codex 已先一步更新该 Session；请查看 Timeline，草稿未重复发送。");
      void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] }); textarea.current?.focus();
    },
    onError: (error) => {
      send.reset(); const code = apiErrorCode(error); if (code === "uncertain_turn_applied") {
        finishSubmission(threadId, true);
        if (queuedUserMessage) removeQueuedSubmission(threadId, queuedUserMessage.clientRequestId, true);
      }
      setResolutionMessage(code === "uncertain_turn_applied" ? "先前请求已出现在 Session 中，未重复发送；请查看 Timeline。" : `无法确认先前请求状态：${error.message}`);
      void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const interrupt = useMutation({ mutationFn: () => api(`/api/sessions/${threadId}/interrupt`, { method: "POST", body: JSON.stringify({ clientRequestId: newClientRequestId() }) }) });

  const lastAttemptedQueuedId = useRef<string | null>(null);
  useEffect(() => {
    if (!queuedSubmission || !activeTurnId || queuedTurnBarrier) return;
    setStoredQueuedTurnBarrier(threadId, { clientRequestId: queuedSubmission.clientRequestId, previousLatestTurnId: latestTurnId, turnId: activeTurnId });
  }, [activeTurnId, latestTurnId, queuedSubmission, queuedTurnBarrier, setStoredQueuedTurnBarrier, threadId]);
  useEffect(() => {
    if (!queuedTurnBarrier) return;
    const next = advanceQueuedTurnBarrier(queuedTurnBarrier, { runtimeState, activeTurnId, latestTurnId, latestTurnStatus });
    if (next !== queuedTurnBarrier) setStoredQueuedTurnBarrier(threadId, next);
  }, [activeTurnId, latestTurnId, latestTurnStatus, queuedTurnBarrier, runtimeState, setStoredQueuedTurnBarrier, threadId]);
  const runQueuedSubmission = useCallback(async () => {
    if (!queuedSubmission || running || blocked || pendingSubmission || queuedTurnBarrier || sendQueuedMessage.isPending || queuedCommandPendingId || lastAttemptedQueuedId.current === queuedSubmission.clientRequestId) return;
    if (!isQueuedTimelineSettled(null, { latestTurnId, latestTurnStatus })) return;
    lastAttemptedQueuedId.current = queuedSubmission.clientRequestId;
    if (queuedSubmission.kind === "message") { sendQueuedMessage.mutate(queuedSubmission); return; }
    setQueuedCommandPendingId(queuedSubmission.clientRequestId);
    try {
      const parsed = parseSlashCommand(queuedSubmission.raw);
      const startsTurn = parsed?.name === "compact" || parsed?.name === "review";
      const result = await executeSlashCommand(queuedSubmission.raw, queuedSubmission.clientRequestId);
      if (result.queuedSettings) applyQueuedSettings(threadId, result.queuedSettings);
      if (startsTurn) {
        setStoredQueuedTurnBarrier(threadId, { clientRequestId: queuedSubmission.clientRequestId, previousLatestTurnId: latestTurnId, ...(result.turnId ? { turnId: result.turnId } : {}) });
        void queryClient.invalidateQueries({ queryKey: ["session", threadId] });
      }
      removeQueuedSubmission(threadId, queuedSubmission.clientRequestId);
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "排队命令执行失败。" });
    } finally {
      setQueuedCommandPendingId(null);
    }
  }, [applyQueuedSettings, blocked, executeSlashCommand, latestTurnId, latestTurnStatus, pendingSubmission, queryClient, queuedCommandPendingId, queuedSubmission, queuedTurnBarrier, removeQueuedSubmission, running, sendQueuedMessage, setStoredQueuedTurnBarrier, threadId]);
  useEffect(() => { void runQueuedSubmission(); }, [runQueuedSubmission]);
  useEffect(() => { if (!queuedSubmission) lastAttemptedQueuedId.current = null; }, [queuedSubmission]);

  const queueCommand = useCallback((raw: string) => {
    const command: QueuedSubmission = { kind: "command", raw: raw.trim(), clientRequestId: newClientRequestId(), createdAt: Date.now() };
    steerDraftTurnId.current = null;
    enqueueSubmission(threadId, command); updateDraft(""); setFeedback({ tone: "info", text: `${command.raw} 已加入队列第 ${queuedSubmissions.length + 1} 项。` });
    if (activeTurnId && !queuedTurnBarrier) setStoredQueuedTurnBarrier(threadId, { clientRequestId: command.clientRequestId, previousLatestTurnId: latestTurnId, turnId: activeTurnId });
  }, [activeTurnId, enqueueSubmission, latestTurnId, queuedSubmissions.length, queuedTurnBarrier, setStoredQueuedTurnBarrier, threadId, updateDraft]);

  const queueMessage = useCallback((raw: string) => {
    const text = raw.trim();
    const message: QueuedSubmission = {
      kind: "message",
      text,
      attachments: [...attachments],
      skillNames: referencedSkillNames(text, skills.data ?? []),
      model,
      reasoning,
      serviceTier,
      accessMode,
      clientRequestId: newClientRequestId(),
      clientUserMessageId: requestId(),
      createdAt: Date.now(),
    };
    steerDraftTurnId.current = null;
    enqueueSubmission(threadId, message); updateDraft(""); setAttachments([]); setFeedback({ tone: "info", text: `需求已加入队列第 ${queuedSubmissions.length + 1} 项。` });
    if (activeTurnId && !queuedTurnBarrier) setStoredQueuedTurnBarrier(threadId, { clientRequestId: message.clientRequestId, previousLatestTurnId: latestTurnId, turnId: activeTurnId });
  }, [accessMode, activeTurnId, attachments, enqueueSubmission, latestTurnId, model, queuedSubmissions.length, queuedTurnBarrier, reasoning, serviceTier, setStoredQueuedTurnBarrier, skills.data, threadId, updateDraft]);

  const rememberSteerIntent = () => { if (deliveryMode === "steer" && running && activeTurnId) steerDraftTurnId.current ??= activeTurnId; };
  const submit = () => {
    if (blocked || send.isPending || uploadingCount > 0 || !hasPayload) return;
    const parsed = parseSlashCommand(draft);
    if (parsed) {
      if (attachments.length) { setFeedback({ tone: "error", text: "Slash 命令不能附带附件；请先移除附件或改为普通消息。" }); return; }
      if (!isSupportedSlashCommand(parsed.name)) { setFeedback({ tone: "error", text: `不支持的 Slash 命令：/${parsed.name}` }); return; }
      if (running && parsed.name !== "goal") { queueCommand(draft); return; }
      const raw = draft.trim(); updateDraft("");
      void executeSlashCommand(raw).catch((error) => { updateDraft(raw); setFeedback({ tone: "error", text: error instanceof Error ? error.message : "命令执行失败。" }); });
      return;
    }
    if (running && deliveryMode === "queue") { queueMessage(draft); return; }
    const expectedTurnId = expectedSteerTurnId(steerDraftTurnId.current, running, activeTurnId); send.mutate({ expectedTurnId });
  };

  const selectMenuOption = (option: MenuOption) => {
    if (menu?.kind === "command" && trigger?.kind === "command") {
      if (option.value === "skills") { updateDraft("$", 1); return; }
      const needsArgument = option.value === "goal" || option.value === "review" || option.value === "model" || option.value === "reasoning" || option.value === "permissions";
      updateDraft(`/${option.value}${needsArgument ? " " : ""}`, undefined, !needsArgument);
      return;
    }
    if (menu?.kind === "skill" && trigger?.kind === "skill") {
      const mention = `$${option.value}`;
      const next = `${draft.slice(0, trigger.start)}${mention} ${draft.slice(trigger.end)}`;
      setCompletedSkillMention({ start: trigger.start, text: mention }); updateDraft(next, trigger.start + mention.length + 1, true); return;
    }
    if (menu?.kind === "argument" && argumentTrigger) {
      const next = `${draft.slice(0, argumentTrigger.start)}${option.value}${draft.slice(argumentTrigger.end)}`; updateDraft(next, next.length, true);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const parsed = parseSlashCommand(draft);
    if (event.key === "Tab" && running && !menu && parsed && isSupportedSlashCommand(parsed.name)) { event.preventDefault(); queueCommand(draft); return; }
    if (menu) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMenuIndex((index) => menu.options.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + menu.options.length) % menu.options.length : 0); return; }
      if ((event.key === "Enter" || event.key === "Tab") && menu.options[menuIndex]) { event.preventDefault(); selectMenuOption(menu.options[menuIndex]!); return; }
      if (event.key === "Escape") { event.preventDefault(); setDismissedMenuDraft(draft); return; }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); rememberSteerIntent(); submit(); }
  };

  const stopPrimaryAction = running && !hasPayload;
  const primaryActionDisabled = stopPrimaryAction
    ? interrupt.isPending
    : blocked || !hasPayload || uploadingCount > 0 || send.isPending || sendQueuedMessage.isPending || (running && deliveryMode === "steer" && !activeTurnId && !parseSlashCommand(draft));
  const runPrimaryAction = () => {
    if (stopPrimaryAction) interrupt.mutate();
    else submit();
  };

  const cancelQueuedSubmission = (submission: QueuedSubmission) => {
    if (submission.clientRequestId === queuedSubmission?.clientRequestId) {
      lastAttemptedQueuedId.current = null;
      sendQueuedMessage.reset();
    }
    removeQueuedSubmission(threadId, submission.clientRequestId);
    if (submission.kind === "message") void Promise.all((submission.attachments ?? []).map((attachment) => endpoints.removeAttachment(attachment.id).catch(() => undefined)));
  };
  const queuedSubmissionSummary = (submission: QueuedSubmission) => submission.kind === "command"
    ? submission.raw
    : submission.text || (submission.attachments ?? []).map((attachment) => attachment.name).join("、");
  const queuedSubmissionStatus = (submission: QueuedSubmission, index: number) => {
    if (index > 0) return "等待前面的队列项";
    if (queuedTurnBarrier) return queuedTurnBarrier.turnId ? "等待当前 Turn 完成" : "正在同步 Turn 状态";
    if (submission.kind === "message" && sendQueuedMessage.isPending) return "正在发送下一 Turn";
    if (submission.kind === "command" && queuedCommandPendingId === submission.clientRequestId) return "正在执行";
    if (lastAttemptedQueuedId.current === submission.clientRequestId && !running) return submission.kind === "message" ? "发送失败，可重试" : "执行失败，可重试";
    return running ? submission.kind === "message" ? "将在当前 Turn 完成后自动发送" : "将在当前 Turn 完成后自动执行" : "正在等待执行";
  };

  return <div className={`composer-wrap ${compact ? "compact" : ""}`}>
    {uncertainTurnStart && <div className="uncertain-turn"><WarningCircle size={16} weight="fill" /><span>Codex 未确认上一条消息是否开始执行。为避免重复任务，请先显式核实；当前草稿不会丢失。</span><button disabled={resolveUncertainTurn.isPending} onClick={() => resolveUncertainTurn.mutate()}>{resolveUncertainTurn.isPending ? "正在核实…" : "确认未执行，恢复输入"}</button></div>}
    {!!queuedSubmissions.length && <div className="queued-submission-list" aria-label={`排队内容，共 ${queuedSubmissions.length} 项`}>
      <div className="queued-submission-heading"><ClockCounterClockwise size={15} weight="fill" /><span>排队内容</span><small>{queuedSubmissions.length} 项</small></div>
      {queuedSubmissions.map((submission, index) => {
        const isHead = index === 0; const pending = isHead && (sendQueuedMessage.isPending || queuedCommandPendingId === submission.clientRequestId);
        const canRetry = isHead && !running && !pending && !queuedTurnBarrier && lastAttemptedQueuedId.current === submission.clientRequestId;
        return <div className={`queued-command-banner ${submission.kind === "message" ? "queued-message-banner" : ""}`} key={submission.clientRequestId}><b>{index + 1}</b><span><strong>{queuedSubmissionSummary(submission)}</strong>{queuedSubmissionStatus(submission, index)}</span>{canRetry && <button onClick={() => { lastAttemptedQueuedId.current = null; sendQueuedMessage.reset(); void runQueuedSubmission(); }}>重试</button>}<button className="icon-only" aria-label={`取消第 ${index + 1} 项排队${submission.kind === "message" ? "需求" : "命令"}`} disabled={pending} onClick={() => cancelQueuedSubmission(submission)}><X size={13} /></button></div>;
      })}
    </div>}
    <div className="composer-shell">
      {menu && <div className="composer-suggestion-menu" role="listbox" aria-label={menu.title}><header><span>{menu.kind === "skill" ? <Cube size={14} /> : <Command size={14} />}{menu.title}</span><small>{menu.options.length} 项</small></header><div className="composer-suggestion-list">{menu.options.length ? menu.options.map((option, index) => <button key={option.key} role="option" aria-selected={index === menuIndex} className={index === menuIndex ? "selected" : ""} onMouseDown={(event) => { event.preventDefault(); selectMenuOption(option); }}><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.meta && <code>{option.meta}</code>}</button>) : <div className="composer-suggestion-empty">没有匹配项</div>}</div><footer>{menu.hint}</footer></div>}
      <div className={`composer ${running ? `${deliveryMode}-mode` : ""} ${draggingFiles ? "dragging-files" : ""}`} onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDraggingFiles(true); } }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false); }} onDrop={(event) => { event.preventDefault(); setDraggingFiles(false); void uploadFiles([...event.dataTransfer.files]); }}>
        {(attachments.length > 0 || uploadingCount > 0) && <div className="attachment-tray" aria-label="待发送附件">
          {attachments.map((attachment) => <div className={`attachment-chip ${attachment.kind}`} key={attachment.id}>
            {attachment.kind === "image" ? <img src={attachment.url} alt={attachment.name} /> : <span className="attachment-file-icon"><FileIcon size={18} /></span>}
            <span className="attachment-copy"><strong>{attachment.name}</strong><small>{formatAttachmentSize(attachment.size)}</small></span>
            <button type="button" aria-label={`移除附件 ${attachment.name}`} title="移除附件" onClick={() => void removeAttachment(attachment)}><X size={12} /></button>
          </div>)}
          {Array.from({ length: uploadingCount }, (_, index) => <div className="attachment-chip uploading" key={`uploading-${index}`}><span className="attachment-file-icon"><SpinnerGap className="spinning" size={18} /></span><span className="attachment-copy"><strong>正在上传</strong><small>请稍候</small></span></div>)}
        </div>}
        {draggingFiles && <div className="attachment-drop-hint"><Paperclip size={18} />松开即可添加附件</div>}
        <textarea ref={bindTextarea} value={draft} rows={2} disabled={blocked} onChange={(event) => { rememberSteerIntent(); setResolutionMessage(null); setFeedback(null); setDismissedMenuDraft(null); setDraft(threadId, event.target.value); setCursor(event.target.selectionStart); }} onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void uploadFiles(files); } }} onSelect={(event) => setCursor(event.currentTarget.selectionStart)} onClick={(event) => setCursor(event.currentTarget.selectionStart)} onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)} onKeyDown={handleKeyDown} placeholder={uncertainTurnStart ? "请先核实上一条消息是否执行" : disconnected ? "Session 正在重新同步" : blocked ? "Project 目录不可用" : running && deliveryMode === "queue" ? "输入排队需求；可连续加入多条" : running ? "追加到当前 Turn；Slash 命令会排队执行" : "输入消息；可粘贴图片或添加文件，$ 调用 Skill，/ 执行命令"} />
        <div className="composer-toolbar">
          <div className="access-control"><ShieldCheck size={16} weight={accessMode === "fullAccess" ? "fill" : "regular"} /><span aria-hidden="true">{accessModeLabel(accessMode)}</span><select aria-label="权限" value={accessMode} onChange={(event) => { const next = event.target.value as AccessMode; effectiveSettings.current = { ...effectiveSettings.current, accessMode: next }; setAccessMode(next); onAccessModeChange?.(next); persistAccessMode.mutate(next); }} disabled={running || blocked}><option value="fullAccess">Full Access</option><option value="workspaceWrite">Workspace Write</option><option value="readOnly">Read Only</option></select></div>
          <div className="composer-controls">
            <div className="composer-settings" role="group" aria-label="模型设置">
              <SettingsSelect className="model-select" variant="model" ariaLabel="模型" menuLabel="选择模型" value={model} options={modelSelectOptions} placeholder="模型" disabled={running || blocked || modelSelectOptions.length === 0} onValueChange={(next) => { const option = models.find((item) => item.model === next || item.id === next); const nextReasoning = preferredReasoningForModel(option); const nextServiceTier = serviceTierForModel(option, effectiveSettings.current.serviceTier); effectiveSettings.current = { ...effectiveSettings.current, model: next, reasoning: nextReasoning, serviceTier: nextServiceTier }; setModel(next); setReasoning(nextReasoning); setServiceTier(nextServiceTier); }} />
              <SettingsSelect className="reasoning-select" variant="reasoning" ariaLabel="Reasoning effort" menuLabel="Reasoning effort" value={reasoning} options={reasoningSelectOptions} placeholder="Reasoning" disabled={running || blocked || reasoningSelectOptions.length === 0} onValueChange={(next) => { effectiveSettings.current = { ...effectiveSettings.current, reasoning: next }; setReasoning(next); }} />
              {fastServiceTier && <button type="button" className={`service-tier-toggle ${fastMode ? "active" : ""}`} role="switch" aria-checked={fastMode} aria-label={`Fast 模式${fastMode ? "已开启" : "已关闭"}`} title={`${fastServiceTier.name}：${fastServiceTier.description}`} disabled={running || blocked} onClick={() => { const next = fastMode ? null : fastServiceTier.id; effectiveSettings.current = { ...effectiveSettings.current, serviceTier: next }; setServiceTier(next); }}><Lightning size={13} weight={fastMode ? "fill" : "regular"} /><span>{fastServiceTier.name}</span></button>}
            </div>
            <div className="composer-actions">
              <input ref={fileInput} className="attachment-input" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={(event) => void uploadFiles([...(event.target.files ?? [])])} />
              <button type="button" className="attachment-picker" aria-label="添加图片或文件" title="添加图片或文件" disabled={blocked || uploadingCount > 0 || attachments.length >= MAX_ATTACHMENTS} onClick={() => fileInput.current?.click()}>{uploadingCount > 0 ? <SpinnerGap className="spinning" size={16} /> : <Paperclip size={17} />}</button>
              <div className={`composer-running-controls ${running ? "is-active" : "is-idle"}`}>
                <button type="button" className={`delivery-mode-toggle ${deliveryMode}`} role="switch" aria-checked={deliveryMode === "queue"} aria-label={running ? `需求发送方式：${deliveryMode === "queue" ? "排队" : "Steer"}` : "需求发送方式当前不可用，没有正在运行的 Turn"} title={running ? deliveryMode === "queue" ? "当前 Turn 完成后自动发送" : "立即追加到当前 Turn" : "当前没有正在运行的 Turn"} disabled={!running} onClick={() => { const next = deliveryMode === "steer" ? "queue" : "steer"; setDeliveryMode(next); if (next === "queue") steerDraftTurnId.current = null; }}><span className="delivery-mode-track" aria-hidden="true"><span /></span><span className="delivery-mode-label">{deliveryMode === "queue" ? "排队" : "Steer"}</span></button>
              </div>
              <button className={stopPrimaryAction ? "stop-button" : "send-button"} onPointerDown={() => { if (!stopPrimaryAction) rememberSteerIntent(); }} onClick={runPrimaryAction} disabled={primaryActionDisabled} aria-label={stopPrimaryAction ? "停止当前 Turn" : running && deliveryMode === "queue" ? "排到下一 Turn" : running ? "Steer 当前 Turn 或排队 Slash 命令" : "发送或执行命令"} title={stopPrimaryAction ? "停止当前 Turn" : undefined}>{stopPrimaryAction ? <Square size={13} weight="fill" /> : running && deliveryMode === "queue" ? <ClockCounterClockwise size={16} weight="bold" /> : <ArrowUp size={17} weight="bold" />}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    {blocked && !uncertainTurnStart && <p className="composer-error">{blockedMessage}</p>}
    {resolutionMessage && <p className={resolutionMessage.startsWith("无法") ? "composer-error" : "composer-resolution"}>{resolutionMessage}</p>}
    {feedback && <p className={`composer-feedback ${feedback.tone}`}>{feedback.text}</p>}
    {skills.isError && trigger?.kind === "skill" && <p className="composer-error">Skills 加载失败：{skills.error.message}</p>}
    {persistAccessMode.error && <p className="composer-error">权限设置保存失败：{persistAccessMode.error.message}</p>}
    {send.error && !uncertainTurnStart && !resolutionMessage && <p className="composer-error">{send.error.message}</p>}{interrupt.error && <p className="composer-error">{interrupt.error.message}</p>}
  </div>;
}
