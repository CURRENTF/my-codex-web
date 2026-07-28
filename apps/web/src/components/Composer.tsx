import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ClockCounterClockwise, Command, Cube, ShieldCheck, Square, WarningCircle, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccessMode, ContextUsage, Goal, ModelOption, Project, RuntimeState, SkillOption } from "@codex-web/shared-types";
import { ApiError, api, endpoints, newClientRequestId } from "../api";
import { commandArgumentSuggestions, composerTrigger, isCompletedSkillTrigger, isSupportedSlashCommand, parseSlashCommand, referencedSkillNames, slashArgumentTrigger, slashCommands, type CompletedSkillMention, type SlashCommandName } from "../composer-commands";
import { expectedSteerTurnId, isTurnFinishedConflict } from "../composer-intent";
import { refreshProjectAvailabilityAfterError } from "../project-refresh";
import { useAppStore, type QueuedUserMessage } from "../store";

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

function preferredReasoningForModel(model: ModelOption | undefined): string {
  return model?.supportedReasoning.find((item) => item.effort === "high")?.effort ?? model?.defaultReasoning ?? "";
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

export function Composer({ threadId, project, models, runtimeState, activeTurnId, uncertainTurnStart = false, initialSettings, goal = null, contextUsage, latestCompletedTurnId = null, compact = false, disabled = false, onTextareaReady, onAccessModeChange, onForkLatest, onOpenSideChat }: {
  threadId: string; project: Project; models: ModelOption[]; runtimeState: RuntimeState; activeTurnId?: string;
  uncertainTurnStart?: boolean;
  initialSettings: { model: string | null; reasoning: string | null; accessMode: AccessMode };
  goal?: Goal | null; contextUsage?: ContextUsage; latestCompletedTurnId?: string | null;
  compact?: boolean; disabled?: boolean; onTextareaReady?(element: HTMLTextAreaElement | null): void;
  onAccessModeChange?(accessMode: AccessMode): void; onForkLatest?(): void; onOpenSideChat?(): void;
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
  const queuedSlashCommand = useAppStore((state) => state.queuedSlashCommands[threadId]);
  const queueSlashCommand = useAppStore((state) => state.queueSlashCommand);
  const clearQueuedSlashCommand = useAppStore((state) => state.clearQueuedSlashCommand);
  const queuedUserMessage = useAppStore((state) => state.queuedUserMessages[threadId]);
  const queueUserMessage = useAppStore((state) => state.queueUserMessage);
  const clearQueuedUserMessage = useAppStore((state) => state.clearQueuedUserMessage);
  const [model, setModel] = useState(initialSettings.model ?? project.defaultModel ?? models.find((item) => item.isDefault)?.model ?? models[0]?.model ?? "");
  const selectedModel = useMemo(() => models.find((item) => item.model === model || item.id === model), [models, model]);
  const [reasoning, setReasoning] = useState(initialSettings.reasoning ?? project.defaultReasoning ?? preferredReasoningForModel(selectedModel));
  const [accessMode, setAccessMode] = useState<AccessMode>(initialSettings.accessMode ?? project.defaultAccessMode);
  const [resolutionMessage, setResolutionMessage] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null); const [cursor, setCursor] = useState(0);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("steer");
  const [menuIndex, setMenuIndex] = useState(0); const [dismissedMenuDraft, setDismissedMenuDraft] = useState<string | null>(null);
  const [completedSkillMention, setCompletedSkillMention] = useState<CompletedSkillMention | null>(null);
  const running = runtimeState === "running" || runtimeState === "waitingForInput"; const disconnected = runtimeState === "disconnected"; const blocked = (disabled || disconnected) && !running;
  const blockedMessage = disabled ? "Project 目录不可用；恢复该目录后重新扫描即可继续。" : "Session 尚未完成重同步；请等待状态恢复后继续。";
  const skills = useQuery({ queryKey: ["skills", project.id], queryFn: ({ signal }) => endpoints.skills(project.id, signal), enabled: project.available && !disconnected, staleTime: 60_000 });

  useEffect(() => {
    const nextModel = initialSettings.model ?? project.defaultModel ?? models.find((item) => item.isDefault)?.model ?? models[0]?.model ?? "";
    const option = models.find((item) => item.model === nextModel || item.id === nextModel);
    setModel(nextModel);
    setReasoning(initialSettings.reasoning ?? project.defaultReasoning ?? preferredReasoningForModel(option));
    setAccessMode(initialSettings.accessMode ?? project.defaultAccessMode);
    steerDraftTurnId.current = null;
    setResolutionMessage(null); setFeedback(null); setDismissedMenuDraft(null); setCompletedSkillMention(null); setCursor(0); setDeliveryMode("steer");
  }, [threadId, initialSettings.model, initialSettings.reasoning, initialSettings.accessMode, project.defaultModel, project.defaultReasoning, project.defaultAccessMode, models]);
  useEffect(() => { if (selectedModel && !selectedModel.supportedReasoning.some((item) => item.effort === reasoning)) setReasoning(selectedModel.defaultReasoning); }, [selectedModel, reasoning]);

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

  const persistAccessMode = useMutation({ mutationFn: (next: AccessMode) => api(`/api/sessions/${threadId}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ accessMode: next, clientRequestId: requestId() }),
  }) });

  const executeSlashCommand = useCallback(async (raw: string, clientRequestId = newClientRequestId()): Promise<void> => {
    const parsed = parseSlashCommand(raw);
    if (!parsed || !isSupportedSlashCommand(parsed.name)) throw new Error(`不支持的 Slash 命令：/${parsed?.name ?? ""}`);
    const command = parsed.name as SlashCommandName; const args = parsed.args;
    if (command === "goal") {
      if (!args) {
        setFeedback({ tone: "info", text: goal ? `Goal · ${goal.status} · ${goal.objective} · ${goal.tokensUsed}/${goal.tokenBudget ?? "∞"} tokens` : "当前 Session 尚未设置 Goal。用 /goal <目标> 创建。" });
        return;
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
      return;
    }
    if (command === "compact") {
      if (args) throw new Error("/compact 不接受参数。");
      await api(`/api/sessions/${threadId}/compact`, { method: "POST", body: JSON.stringify({ clientRequestId }) });
      setFeedback({ tone: "success", text: "上下文压缩已启动。" });
      return;
    }
    if (command === "review") {
      const target = !args ? { type: "uncommittedChanges" as const }
        : args.startsWith("base ") ? { type: "baseBranch" as const, branch: args.slice(5).trim() }
          : args.startsWith("commit ") ? { type: "commit" as const, sha: args.slice(7).trim(), title: null }
            : { type: "custom" as const, instructions: args };
      if ((target.type === "baseBranch" && !target.branch) || (target.type === "commit" && !target.sha)) throw new Error("/review 参数不完整。");
      await api(`/api/sessions/${threadId}/review`, { method: "POST", body: JSON.stringify({ target, clientRequestId }) });
      setFeedback({ tone: "success", text: "Review 已启动。" });
      await queryClient.invalidateQueries({ queryKey: ["session", threadId] });
      return;
    }
    if (command === "fork") {
      if (args) throw new Error("/fork 不接受参数。");
      if (!latestCompletedTurnId || !onForkLatest) throw new Error("当前没有可 Fork 的已完成 Turn。");
      onForkLatest(); setFeedback({ tone: "success", text: "正在从最新完成位置创建 Fork。" }); return;
    }
    if (command === "side") {
      if (args) throw new Error("/side 不接受参数。");
      if (!onOpenSideChat) throw new Error("当前视图不支持 Side Chat。");
      onOpenSideChat(); setFeedback({ tone: "success", text: "正在打开 Side Chat。" }); return;
    }
    if (command === "model") {
      const option = models.find((item) => item.model === args || item.id === args);
      if (!option) throw new Error("请选择 /model 菜单中列出的模型。");
      setModel(option.model); setReasoning(preferredReasoningForModel(option)); setFeedback({ tone: "success", text: `模型已切换为 ${option.displayName}；将在下一 Turn 生效。` }); return;
    }
    if (command === "reasoning") {
      if (!selectedModel?.supportedReasoning.some((item) => item.effort === args)) throw new Error("请选择当前模型支持的 Reasoning 强度。");
      setReasoning(args); setFeedback({ tone: "success", text: `Reasoning 已切换为 ${args}；将在下一 Turn 生效。` }); return;
    }
    if (command === "permissions") {
      const next = normalizeAccessMode(args);
      if (!next) throw new Error("权限仅支持 fullAccess、workspaceWrite、readOnly。");
      await persistAccessMode.mutateAsync(next); setAccessMode(next); onAccessModeChange?.(next);
      setFeedback({ tone: "success", text: `权限已切换为 ${accessModeLabel(next)}。` }); return;
    }
    if (command === "status") {
      if (args) throw new Error("/status 不接受参数。");
      const context = contextUsage ? `${contextUsage.usedTokens.toLocaleString()} / ${contextUsage.maxTokens?.toLocaleString() ?? "?"} tokens` : "尚无数据";
      setFeedback({ tone: "info", text: `${runtimeState} · ${selectedModel?.displayName ?? model} · reasoning ${reasoning || "default"} · ${accessModeLabel(accessMode)} · 上下文 ${context}` }); return;
    }
    updateDraft("$", 1); setFeedback(null);
  }, [accessMode, contextUsage, goal, latestCompletedTurnId, model, models, onAccessModeChange, onForkLatest, onOpenSideChat, persistAccessMode, queryClient, reasoning, runtimeState, selectedModel, threadId, updateDraft]);

  const send = useMutation({ mutationFn: async ({ expectedTurnId }: { expectedTurnId?: string | null } = {}) => {
    const submittedDraft = draft; const text = submittedDraft.trim(); if (!text) return;
    const clientRequestId = requestId();
    const retry = !expectedTurnId && pendingSubmission?.state === "retryReady" && pendingSubmission.draft === submittedDraft;
    const clientUserMessageId = retry ? pendingSubmission.clientUserMessageId : requestId();
    const skillNames = referencedSkillNames(text, skills.data ?? []);
    beginSubmission(threadId, submittedDraft, clientUserMessageId);
    if (expectedTurnId) {
      try {
        return await api(`/api/sessions/${threadId}/steer`, { method: "POST", body: JSON.stringify({ text, skillNames, expectedTurnId, clientRequestId, clientUserMessageId }) });
      } catch (error) {
        if (!isTurnFinishedConflict(error)) throw error;
        steerDraftTurnId.current = null;
      }
    }
    return api(`/api/sessions/${threadId}/turns`, { method: "POST", body: JSON.stringify({ text, skillNames, model, reasoning, accessMode, clientRequestId: expectedTurnId ? requestId() : clientRequestId, clientUserMessageId }) });
  }, onSuccess: () => { steerDraftTurnId.current = null; acceptSubmission(threadId); setResolutionMessage(null); setFeedback(null); void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] }); }, onError: (error) => {
    void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    if (apiErrorCode(error) === "operation_uncertain") { markSubmissionUncertain(threadId); return; }
    finishSubmission(threadId, false);
    void refreshProjectAvailabilityAfterError(error, (queryKey) => queryClient.invalidateQueries({ queryKey }));
  } });

  const sendQueuedMessage = useMutation({ mutationFn: async (message: QueuedUserMessage) => {
    beginSubmission(threadId, message.text, message.clientUserMessageId);
    return api(`/api/sessions/${threadId}/turns`, {
      method: "POST",
      body: JSON.stringify({
        text: message.text,
        skillNames: message.skillNames,
        model: message.model,
        reasoning: message.reasoning,
        accessMode: message.accessMode,
        clientRequestId: message.clientRequestId,
        clientUserMessageId: message.clientUserMessageId,
      }),
    });
  }, onSuccess: (_result, message) => {
    acceptSubmission(threadId); clearQueuedUserMessage(threadId, message.clientRequestId, true); setFeedback(null);
    void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] });
  }, onError: (error, message) => {
    if (apiErrorCode(error) === "operation_uncertain") {
      markSubmissionUncertain(threadId);
      setFeedback({ tone: "info", text: "排队需求的发送结果尚未确认；请先核实，系统不会自动重复发送。" });
      return;
    }
    finishSubmission(threadId, false); queueUserMessage(threadId, message);
    setFeedback({ tone: "error", text: `排队需求发送失败：${error.message}` });
    void refreshProjectAvailabilityAfterError(error, (queryKey) => queryClient.invalidateQueries({ queryKey }));
  } });

  const resolveUncertainTurn = useMutation({
    mutationFn: () => api<{ status: "notApplied" | "alreadyResolved"; clientUserMessageId?: string; draft?: string }>(`/api/sessions/${threadId}/resolve-uncertain-turn`, { method: "POST", body: JSON.stringify({ clientRequestId: newClientRequestId() }) }),
    onSuccess: (result) => {
      send.reset();
      if (result.status === "notApplied") {
        if (queuedUserMessage) {
          clearQueuedUserMessage(threadId, queuedUserMessage.clientRequestId);
          setDraft(threadId, result.draft ?? queuedUserMessage.text);
          setDeliveryMode("steer");
        }
        if (result.draft && !pendingSubmission) { setDraft(threadId, result.draft); beginSubmission(threadId, result.draft, result.clientUserMessageId ?? requestId()); }
        markSubmissionRetryReady(threadId, result.clientUserMessageId);
      } else if (queuedUserMessage) {
        clearQueuedUserMessage(threadId, queuedUserMessage.clientRequestId, true);
      }
      setResolutionMessage(result.status === "notApplied" ? "当前快照未发现先前请求；再次发送将复用原消息 ID，避免迟到请求造成重复 Turn。" : "Codex 已先一步更新该 Session；请查看 Timeline，草稿未重复发送。");
      void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] }); textarea.current?.focus();
    },
    onError: (error) => {
      send.reset(); const code = apiErrorCode(error); if (code === "uncertain_turn_applied") {
        finishSubmission(threadId, true);
        if (queuedUserMessage) clearQueuedUserMessage(threadId, queuedUserMessage.clientRequestId, true);
      }
      setResolutionMessage(code === "uncertain_turn_applied" ? "先前请求已出现在 Session 中，未重复发送；请查看 Timeline。" : `无法确认先前请求状态：${error.message}`);
      void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const interrupt = useMutation({ mutationFn: () => api(`/api/sessions/${threadId}/interrupt`, { method: "POST", body: JSON.stringify({ clientRequestId: newClientRequestId() }) }) });

  const lastAttemptedQueuedId = useRef<string | null>(null);
  const lastAttemptedQueuedMessageId = useRef<string | null>(null);
  const runQueuedCommand = useCallback(async () => {
    if (!queuedSlashCommand || running || blocked || lastAttemptedQueuedId.current === queuedSlashCommand.clientRequestId) return;
    lastAttemptedQueuedId.current = queuedSlashCommand.clientRequestId;
    try {
      await executeSlashCommand(queuedSlashCommand.raw, queuedSlashCommand.clientRequestId);
      clearQueuedSlashCommand(threadId, queuedSlashCommand.clientRequestId);
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "排队命令执行失败。" });
    }
  }, [blocked, clearQueuedSlashCommand, executeSlashCommand, queuedSlashCommand, running, threadId]);
  useEffect(() => { void runQueuedCommand(); }, [runQueuedCommand]);

  const runQueuedMessage = useCallback(() => {
    if (!queuedUserMessage || running || blocked || sendQueuedMessage.isPending || lastAttemptedQueuedMessageId.current === queuedUserMessage.clientRequestId) return;
    lastAttemptedQueuedMessageId.current = queuedUserMessage.clientRequestId;
    sendQueuedMessage.mutate(queuedUserMessage);
  }, [blocked, queuedUserMessage, running, sendQueuedMessage]);
  useEffect(() => { runQueuedMessage(); }, [runQueuedMessage]);
  useEffect(() => { if (!queuedUserMessage) lastAttemptedQueuedMessageId.current = null; }, [queuedUserMessage]);

  const queueCommand = useCallback((raw: string) => {
    if (queuedSlashCommand || queuedUserMessage) { setFeedback({ tone: "error", text: "当前 Session 已有一项排队内容；请先取消或等待执行。" }); return; }
    const command = { raw: raw.trim(), clientRequestId: newClientRequestId(), createdAt: Date.now() };
    steerDraftTurnId.current = null;
    queueSlashCommand(threadId, command); updateDraft(""); setFeedback({ tone: "info", text: `${command.raw} 将在当前 Turn 完成后自动执行。` });
  }, [queueSlashCommand, queuedSlashCommand, queuedUserMessage, threadId, updateDraft]);

  const queueMessage = useCallback((raw: string) => {
    if (queuedSlashCommand || queuedUserMessage) { setFeedback({ tone: "error", text: "当前 Session 已有一项排队内容；请先取消或等待执行。" }); return; }
    const text = raw.trim();
    const message: QueuedUserMessage = {
      text,
      skillNames: referencedSkillNames(text, skills.data ?? []),
      model,
      reasoning,
      accessMode,
      clientRequestId: newClientRequestId(),
      clientUserMessageId: requestId(),
      createdAt: Date.now(),
    };
    steerDraftTurnId.current = null;
    queueUserMessage(threadId, message); updateDraft(""); setFeedback({ tone: "info", text: "需求已排队，将在当前 Turn 完成后自动发送。" });
  }, [accessMode, model, queueUserMessage, queuedSlashCommand, queuedUserMessage, reasoning, skills.data, threadId, updateDraft]);

  const rememberSteerIntent = () => { if (deliveryMode === "steer" && running && activeTurnId) steerDraftTurnId.current ??= activeTurnId; };
  const submit = () => {
    if (blocked || send.isPending || !draft.trim()) return;
    const parsed = parseSlashCommand(draft);
    if (parsed) {
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

  const stopPrimaryAction = running && !draft.trim();
  const primaryActionDisabled = stopPrimaryAction
    ? interrupt.isPending
    : blocked || !draft.trim() || send.isPending || sendQueuedMessage.isPending || (running && deliveryMode === "steer" && !activeTurnId && !parseSlashCommand(draft));
  const runPrimaryAction = () => {
    if (stopPrimaryAction) interrupt.mutate();
    else submit();
  };

  return <div className={`composer-wrap ${compact ? "compact" : ""}`}>
    {uncertainTurnStart && <div className="uncertain-turn"><WarningCircle size={16} weight="fill" /><span>Codex 未确认上一条消息是否开始执行。为避免重复任务，请先显式核实；当前草稿不会丢失。</span><button disabled={resolveUncertainTurn.isPending} onClick={() => resolveUncertainTurn.mutate()}>{resolveUncertainTurn.isPending ? "正在核实…" : "确认未执行，恢复输入"}</button></div>}
    {queuedSlashCommand && <div className="queued-command-banner"><ClockCounterClockwise size={15} weight="fill" /><span><strong>{queuedSlashCommand.raw}</strong>{running ? "将在当前 Turn 完成后自动执行" : "正在等待执行"}</span>{!running && <button onClick={() => { lastAttemptedQueuedId.current = null; void runQueuedCommand(); }}>重试</button>}<button className="icon-only" aria-label="取消排队命令" onClick={() => clearQueuedSlashCommand(threadId, queuedSlashCommand.clientRequestId)}><X size={13} /></button></div>}
    {queuedUserMessage && <div className="queued-command-banner queued-message-banner"><ClockCounterClockwise size={15} weight="fill" /><span><strong>{queuedUserMessage.text}</strong>{running ? "将在当前 Turn 完成后自动发送" : sendQueuedMessage.isPending ? "正在发送下一 Turn" : sendQueuedMessage.isError ? "发送失败，可重试" : "正在等待发送"}</span>{!running && !sendQueuedMessage.isPending && <button onClick={() => { lastAttemptedQueuedMessageId.current = null; sendQueuedMessage.reset(); runQueuedMessage(); }}>重试</button>}<button className="icon-only" aria-label="取消排队需求" disabled={sendQueuedMessage.isPending} onClick={() => clearQueuedUserMessage(threadId, queuedUserMessage.clientRequestId)}><X size={13} /></button></div>}
    <div className="composer-shell">
      {menu && <div className="composer-suggestion-menu" role="listbox" aria-label={menu.title}><header><span>{menu.kind === "skill" ? <Cube size={14} /> : <Command size={14} />}{menu.title}</span><small>{menu.options.length} 项</small></header><div className="composer-suggestion-list">{menu.options.length ? menu.options.map((option, index) => <button key={option.key} role="option" aria-selected={index === menuIndex} className={index === menuIndex ? "selected" : ""} onMouseDown={(event) => { event.preventDefault(); selectMenuOption(option); }}><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.meta && <code>{option.meta}</code>}</button>) : <div className="composer-suggestion-empty">没有匹配项</div>}</div><footer>{menu.hint}</footer></div>}
      <div className={`composer ${running ? `${deliveryMode}-mode` : ""}`}>
        <textarea ref={bindTextarea} value={draft} rows={2} disabled={blocked} onChange={(event) => { rememberSteerIntent(); setResolutionMessage(null); setFeedback(null); setDismissedMenuDraft(null); setDraft(threadId, event.target.value); setCursor(event.target.selectionStart); }} onSelect={(event) => setCursor(event.currentTarget.selectionStart)} onClick={(event) => setCursor(event.currentTarget.selectionStart)} onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)} onKeyDown={handleKeyDown} placeholder={uncertainTurnStart ? "请先核实上一条消息是否执行" : disconnected ? "Session 正在重新同步" : blocked ? "Project 目录不可用" : running && deliveryMode === "queue" ? "输入下一轮需求；当前 Turn 完成后自动发送" : running ? "追加到当前 Turn；Slash 命令会排到下一轮" : "输入消息；$ 调用 Skill，/ 执行命令"} />
        <div className="composer-toolbar">
          <div className="access-control"><ShieldCheck size={16} weight={accessMode === "fullAccess" ? "fill" : "regular"} /><span aria-hidden="true">{accessModeLabel(accessMode)}</span><select aria-label="权限" value={accessMode} onChange={(event) => { const next = event.target.value as AccessMode; setAccessMode(next); onAccessModeChange?.(next); persistAccessMode.mutate(next); }} disabled={running || blocked}><option value="fullAccess">Full Access</option><option value="workspaceWrite">Workspace Write</option><option value="readOnly">Read Only</option></select></div>
          <div className="composer-controls">
            <div className="composer-settings" role="group" aria-label="模型设置">
              <label className="inline-select model-select"><span aria-hidden="true">{selectedModel?.displayName ?? model}</span><select aria-label="模型" value={model} onChange={(event) => { const next = event.target.value; setModel(next); setReasoning(preferredReasoningForModel(models.find((item) => item.model === next || item.id === next))); }} disabled={running || blocked}>{models.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}</select></label>
              <label className="inline-select reasoning-select"><span aria-hidden="true">{reasoning}</span><select aria-label="Reasoning effort" value={reasoning} onChange={(event) => setReasoning(event.target.value)} disabled={running || blocked}>{selectedModel?.supportedReasoning.map((item) => <option key={item.effort} value={item.effort}>{item.effort}</option>)}</select></label>
            </div>
            <div className="composer-actions">
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
