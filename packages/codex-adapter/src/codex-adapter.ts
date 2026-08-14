import { EventEmitter } from "node:events";
import type { AccessMode, Goal, ModelOption, RuntimeState, SessionThread, SessionTurn, SkillOption, SubagentAgentStatus, SubagentDescriptor } from "@codex-web/shared-types";
import type { Account } from "@codex-web/codex-schema/v2/Account";
import type { GetAccountResponse } from "@codex-web/codex-schema/v2/GetAccountResponse";
import type { ModelListResponse } from "@codex-web/codex-schema/v2/ModelListResponse";
import type { ReviewStartResponse } from "@codex-web/codex-schema/v2/ReviewStartResponse";
import type { ReviewTarget } from "@codex-web/codex-schema/v2/ReviewTarget";
import type { SkillsListResponse } from "@codex-web/codex-schema/v2/SkillsListResponse";
import type { ThreadForkResponse } from "@codex-web/codex-schema/v2/ThreadForkResponse";
import type { ThreadGoal } from "@codex-web/codex-schema/v2/ThreadGoal";
import type { ThreadGoalGetResponse } from "@codex-web/codex-schema/v2/ThreadGoalGetResponse";
import type { ThreadGoalSetParams } from "@codex-web/codex-schema/v2/ThreadGoalSetParams";
import type { ThreadGoalSetResponse } from "@codex-web/codex-schema/v2/ThreadGoalSetResponse";
import type { ThreadListResponse } from "@codex-web/codex-schema/v2/ThreadListResponse";
import type { ThreadReadResponse } from "@codex-web/codex-schema/v2/ThreadReadResponse";
import type { ThreadResumeResponse } from "@codex-web/codex-schema/v2/ThreadResumeResponse";
import type { ThreadStartResponse } from "@codex-web/codex-schema/v2/ThreadStartResponse";
import type { ThreadSettings } from "@codex-web/codex-schema/v2/ThreadSettings";
import type { TurnStartResponse } from "@codex-web/codex-schema/v2/TurnStartResponse";
import { JsonRpcError, JsonRpcMutationConnectionLostError, JsonRpcMutationResponseTimeoutError, type RpcServerRequest } from "./json-rpc-transport.js";
import { projectAdapterEvent, projectSubagentDescriptor } from "./adapter-events.js";
import { pendingRequestResponse, projectPendingRequest } from "./pending-requests.js";
import { CodexProcessSupervisor } from "./supervisor.js";
import { projectThread, projectTurn } from "./ui-projection.js";

export type { ReviewTarget } from "@codex-web/codex-schema/v2/ReviewTarget";

export interface AdapterOptions {
  cwd: string;
  codexHome: string;
  codexCommand?: string;
  version: string;
}

export interface ListSessionsInput {
  cursor?: string | null;
  limit?: number;
  sortDirection?: "asc" | "desc";
  cwd?: string | string[];
  searchTerm?: string;
  archived?: boolean;
}

export interface SessionSettings {
  model: string | null;
  reasoning: string | null;
  accessMode: AccessMode;
}

export interface ResumedSession {
  thread: SessionThread;
  settings: SessionSettings;
}

export interface ListedSession {
  id: string; preview: string; name: string | null; cwd: string; sourceKind: string;
  createdAt: number; updatedAt: number; forkedFromId: string | null; threadSource?: string | null;
}

export interface ListedSubagent extends SubagentDescriptor {
  state: RuntimeState;
  activeFlags: string[];
  agentStatus: SubagentAgentStatus;
}

export interface GoalUpdate {
  threadId: string; objective?: string; status?: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"; tokenBudget?: number | null;
}

export interface SkillReference {
  name: string;
  path: string;
}

export interface AttachmentReference {
  kind: "image" | "file";
  name: string;
  path: string;
}

export class OperationUncertainError extends Error {
  readonly code = "operation_uncertain";

  constructor(readonly operation: string, cause?: unknown) {
    super(`Codex did not confirm ${operation}; the operation result is unknown and the connection is restarting`, { cause });
    this.name = "OperationUncertainError";
  }
}

const SIDE_CHAT_INSTRUCTIONS = `You are in a side chat forked from a parent Codex session. The parent history is reference context only. Do not continue the parent task or plan. Only messages after the side-chat boundary define the current task. Default to explanation and lightweight exploration. Modify files only when the side-chat user explicitly asks. Do not start, steer, or control subagents belonging to the parent session.`;

export const SIDE_CHAT_BOUNDARY_TIMEOUT_MS = 15_000;
export const SIDE_CHAT_CLEANUP_RETRY_BASE_MS = 1_000;
const SIDE_CHAT_CLEANUP_RETRY_MAX_MS = 30_000;
export const ACKNOWLEDGED_MUTATION_TIMEOUT_MS = 30_000;
export const acknowledgedMutationTimeout = (timeoutMs = ACKNOWLEDGED_MUTATION_TIMEOUT_MS) => ({
  timeoutMs,
  disconnectOnTimeout: true,
  operationUncertainOnDisconnect: true,
} as const);
export const NON_IDEMPOTENT_MUTATION_TIMEOUT = {
  timeoutMs: 60_000,
  disconnectOnTimeout: true,
  operationUncertainOnDisconnect: true,
} as const;

function sandboxMode(accessMode: AccessMode): "danger-full-access" | "workspace-write" | "read-only" {
  if (accessMode === "fullAccess") return "danger-full-access";
  if (accessMode === "readOnly") return "read-only";
  return "workspace-write";
}

function sandboxPolicy(accessMode: AccessMode, cwd: string) {
  if (accessMode === "fullAccess") return { type: "dangerFullAccess" as const };
  if (accessMode === "readOnly") return { type: "readOnly" as const, networkAccess: false };
  return {
    type: "workspaceWrite" as const,
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function reasoningConfig(settings: Pick<SessionSettings, "reasoning">): { model_reasoning_effort: string } | undefined {
  return settings.reasoning ? { model_reasoning_effort: settings.reasoning } : undefined;
}

function promptInput(text: string, skills: readonly SkillReference[], attachments: readonly AttachmentReference[]) {
  return [
    ...skills.map((skill) => ({ type: "skill" as const, name: skill.name, path: skill.path })),
    ...(text.trim() ? [{ type: "text" as const, text, text_elements: [] }] : []),
    ...attachments.map((attachment) => attachment.kind === "image"
      ? ({ type: "localImage" as const, path: attachment.path })
      : ({ type: "mention" as const, name: attachment.name, path: attachment.path })),
  ];
}

export function isThreadMaterializationRace(error: unknown): boolean {
  return error instanceof JsonRpcError
    && /no rollout found|not materialized yet|rollout\b.*\bis empty\b/i.test(error.message);
}

export async function retryThreadMaterialization<T>(
  operation: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  const delays = [50, 100, 200, 400, 800];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isThreadMaterializationRace(error)) throw error;
      await wait(delay);
    }
  }
}

type ProtocolSessionSettings = Pick<ThreadSettings, "model" | "effort" | "approvalPolicy" | "sandboxPolicy">;

export function projectSessionSettings(settings: ProtocolSessionSettings): SessionSettings {
  const accessMode: AccessMode = settings.sandboxPolicy.type === "dangerFullAccess" && settings.approvalPolicy === "never"
    ? "fullAccess"
    : settings.sandboxPolicy.type === "workspaceWrite"
      ? "workspaceWrite"
      : "readOnly";
  return {
    model: settings.model || null,
    reasoning: settings.effort ?? null,
    accessMode,
  };
}

function projectResumeSettings(response: ThreadResumeResponse): SessionSettings {
  return projectSessionSettings({
    model: response.model,
    effort: response.reasoningEffort,
    approvalPolicy: response.approvalPolicy,
    sandboxPolicy: response.sandbox,
  });
}

export class CodexAdapter extends EventEmitter {
  readonly supervisor: CodexProcessSupervisor;
  private ready = false;
  private accountValue: Account | null = null;
  private accountChecked = false;
  private accountCheckPromise: Promise<void> | null = null;
  private modelsValue: ModelOption[] = [];
  private readonly pendingRequests = new Map<string, RpcServerRequest>();
  private readonly failedSideChatCleanupAttempts = new Map<string, number>();
  private readonly failedSideChatCleanupTimers = new Map<string, NodeJS.Timeout>();
  private pendingNonIdempotentMutations = 0;
  private pendingAcknowledgedMutations = 0;

  constructor(private readonly options: AdapterOptions) {
    super();
    this.supervisor = new CodexProcessSupervisor({
      command: options.codexCommand,
      cwd: options.cwd,
      codexHome: options.codexHome,
    });
    this.supervisor.on("notification", (message) => {
      const event = projectAdapterEvent(message);
      if (!event) return;
      if (event.type === "serverRequestResolved") this.pendingRequests.delete(event.requestId);
      this.emit("event", event);
    });
    this.supervisor.on("serverRequest", (request: RpcServerRequest) => {
      const projected = projectPendingRequest(request);
      if (!projected) {
        this.supervisor.transport.respondError(request.id, -32_601, "Codex Web does not support this server request");
        return;
      }
      this.pendingRequests.set(projected.id, request);
      this.emit("pendingRequest", projected);
    });
    this.supervisor.on("stderr", (line) => this.emit("stderr", line));
    this.supervisor.on("disconnected", (details) => {
      this.ready = false;
      this.pendingRequests.clear();
      this.emit("connection", { state: "disconnected", details });
    });
    this.supervisor.on("restart", () => void this.initialize().catch((error) => {
      this.emit("error", error);
      this.supervisor.retryCurrent();
    }));
  }

  get connected(): boolean { return this.ready; }
  get account(): Account | null { return this.accountValue; }
  get models(): ModelOption[] { return this.modelsValue; }

  async start(): Promise<void> {
    await this.supervisor.start();
    await this.initialize().catch((error) => {
      this.emit("error", error);
      this.supervisor.retryCurrent();
    });
  }

  stop(): void {
    this.clearFailedSideChatCleanups();
    this.supervisor.stop();
  }

  async initialize(): Promise<void> {
    // A supervisor restart destroys every ephemeral Thread from the old process.
    this.clearFailedSideChatCleanups();
    this.emit("connection", { state: "connecting" });
    const transport = this.supervisor.transport;
    await transport.request("initialize", {
      clientInfo: { name: "codex-web", title: "Codex Web", version: this.options.version },
      capabilities: null,
    });
    transport.notify("initialized");
    const [, models] = await Promise.all([
      this.ensureAccountChecked(),
      this.listModels(),
    ]);
    this.modelsValue = models;
    this.ready = true;
    this.supervisor.markReady();
    this.emit("connection", { state: "connected" });
  }

  async readAccount(): Promise<GetAccountResponse> {
    return this.supervisor.transport.request<GetAccountResponse>("account/read", { refreshToken: false });
  }

  private ensureAccountChecked(): Promise<void> {
    if (this.accountChecked) return Promise.resolve();
    this.accountCheckPromise ??= this.readAccount()
      .then((account) => {
        this.accountValue = account.account;
        this.accountChecked = true;
      })
      .catch((error: unknown) => {
        this.accountCheckPromise = null;
        throw error;
      });
    return this.accountCheckPromise;
  }

  async listModels(): Promise<ModelOption[]> {
    const models: ModelListResponse["data"] = [];
    let cursor: string | null = null;
    do {
      const response: ModelListResponse = await this.supervisor.transport.request<ModelListResponse>("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      models.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return models.filter((model) => !model.hidden).map((model) => ({
      id: model.id,
      model: model.model,
      displayName: model.displayName,
      description: model.description,
      isDefault: model.isDefault,
      defaultReasoning: model.defaultReasoningEffort,
      supportedReasoning: model.supportedReasoningEfforts.map((option) => ({
        effort: option.reasoningEffort,
        description: option.description,
      })),
      inputModalities: model.inputModalities,
    }));
  }

  async listSkills(cwd: string): Promise<SkillOption[]> {
    const response = await this.supervisor.transport.request<SkillsListResponse>("skills/list", { cwds: [cwd], forceReload: false });
    const seen = new Set<string>();
    return response.data.flatMap((entry) => entry.skills).flatMap((skill) => {
      if (!skill.enabled || seen.has(skill.name)) return [];
      seen.add(skill.name);
      return [{ name: skill.name, description: skill.description, path: skill.path, scope: skill.scope }];
    });
  }

  async listSessions(input: ListSessionsInput = {}): Promise<{ data: ListedSession[]; nextCursor: string | null }> {
    const response = await this.supervisor.transport.request<ThreadListResponse>("thread/list", {
      cursor: input.cursor ?? null,
      limit: input.limit ?? 100,
      sortKey: "updated_at",
      sortDirection: input.sortDirection ?? "desc",
      sourceKinds: ["cli", "vscode", "appServer"],
      archived: input.archived ?? false,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.searchTerm ? { searchTerm: input.searchTerm } : {}),
    });
    return { data: response.data.map((thread) => ({ id: thread.id, preview: thread.preview, name: thread.name, cwd: thread.cwd, sourceKind: protocolSourceKind(thread.source), createdAt: thread.createdAt, updatedAt: thread.updatedAt, forkedFromId: thread.forkedFromId, threadSource: thread.threadSource })), nextCursor: response.nextCursor };
  }

  async listSubagents(cursor: string | null = null, limit = 100): Promise<{ data: ListedSubagent[]; nextCursor: string | null }> {
    const response = await this.supervisor.transport.request<ThreadListResponse>("thread/list", {
      cursor,
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"],
      archived: false,
    });
    return {
      data: response.data.flatMap((thread) => {
        const descriptor = projectSubagentDescriptor(thread);
        if (!descriptor) return [];
        const activeFlags = thread.status.type === "active" ? thread.status.activeFlags.map(String) : [];
        const waitingForInput = activeFlags.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput");
        const state: RuntimeState = thread.status.type === "active"
          ? waitingForInput ? "waitingForInput" : "running"
          : thread.status.type === "systemError" ? "failed" : "idle";
        const agentStatus: SubagentAgentStatus = thread.status.type === "active"
          ? "running"
          : thread.status.type === "systemError"
            ? "errored"
            : thread.status.type === "idle" ? "completed" : "notLoaded";
        return [{ ...descriptor, state, activeFlags, agentStatus }];
      }),
      nextCursor: response.nextCursor,
    };
  }

  async readSession(threadId: string): Promise<SessionThread> {
    const response = await this.supervisor.transport.request<ThreadReadResponse>("thread/read", { threadId, includeTurns: true });
    return projectThread(response.thread);
  }

  async resumeSession(threadId: string, settings?: Partial<SessionSettings>): Promise<ResumedSession> {
    const response = await this.supervisor.transport.request<ThreadResumeResponse>("thread/resume", {
      threadId,
      ...(settings?.model ? { model: settings.model } : {}),
      ...(settings?.accessMode ? { approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request", sandbox: sandboxMode(settings.accessMode) } : {}),
      ...(settings?.reasoning ? { config: reasoningConfig({ reasoning: settings.reasoning }) } : {}),
    });
    return { thread: projectThread(response.thread), settings: projectResumeSettings(response) };
  }

  async startSession(cwd: string, settings: SessionSettings, ephemeral = false, threadSource = "codex-web"): Promise<{ thread: SessionThread }> {
    const response = await this.nonIdempotentMutation<ThreadStartResponse>("thread/start", {
      cwd,
      model: settings.model ?? null,
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandbox: sandboxMode(settings.accessMode),
      ...(reasoningConfig(settings) ? { config: reasoningConfig(settings) } : {}),
      ephemeral,
      threadSource,
    });
    return { thread: projectThread(response.thread) };
  }

  async startTurn(threadId: string, cwd: string, text: string, settings: SessionSettings, clientUserMessageId: string, skills: readonly SkillReference[] = [], attachments: readonly AttachmentReference[] = []): Promise<{ turn: SessionTurn }> {
    const response = await this.nonIdempotentMutation<TurnStartResponse>("turn/start", {
      threadId,
      clientUserMessageId,
      input: promptInput(text, skills, attachments),
      cwd,
      model: settings.model ?? null,
      effort: settings.reasoning ?? null,
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandboxPolicy: sandboxPolicy(settings.accessMode, cwd),
    });
    return { turn: projectTurn(response.turn) };
  }

  async steerTurn(threadId: string, expectedTurnId: string, text: string, clientUserMessageId: string, skills: readonly SkillReference[] = [], attachments: readonly AttachmentReference[] = []): Promise<{ turnId: string }> {
    return this.nonIdempotentMutation("turn/steer", {
      threadId,
      expectedTurnId,
      clientUserMessageId,
      input: promptInput(text, skills, attachments),
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.acknowledgedMutation("turn/interrupt", { threadId, turnId });
  }

  async forkSession(threadId: string, lastTurnId: string | null, settings: SessionSettings, ephemeral = false, cwd = this.options.cwd, threadSource = "codex-web"): Promise<{ thread: SessionThread }> {
    const response = await this.nonIdempotentMutation<ThreadForkResponse>("thread/fork", {
      threadId,
      ...(lastTurnId ? { lastTurnId } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      cwd,
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandbox: sandboxMode(settings.accessMode),
      ...(reasoningConfig(settings) ? { config: reasoningConfig(settings) } : {}),
      ephemeral,
      threadSource,
    });
    return { thread: projectThread(response.thread) };
  }

  async createSideChat(threadId: string, lastTurnId: string | null, settings: SessionSettings, cwd = this.options.cwd): Promise<{ thread: SessionThread }> {
    const response = await retryThreadMaterialization(() => this.nonIdempotentMutation<ThreadForkResponse>("thread/fork", {
      threadId,
      ...(lastTurnId ? { lastTurnId } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      cwd,
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandbox: sandboxMode(settings.accessMode),
      ...(reasoningConfig(settings) ? { config: reasoningConfig(settings) } : {}),
      ephemeral: true,
      developerInstructions: SIDE_CHAT_INSTRUCTIONS,
      threadSource: "codex-web-side-chat",
    }));
    await this.initializeSideChatThread(response.thread.id);
    return { thread: projectThread(response.thread) };
  }

  async createEmptySideChat(cwd: string, settings: SessionSettings): Promise<{ thread: SessionThread }> {
    const response = await this.nonIdempotentMutation<ThreadStartResponse>("thread/start", {
      cwd,
      ...(settings.model ? { model: settings.model } : {}),
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandbox: sandboxMode(settings.accessMode),
      ...(reasoningConfig(settings) ? { config: reasoningConfig(settings) } : {}),
      ephemeral: true,
      developerInstructions: SIDE_CHAT_INSTRUCTIONS,
      threadSource: "codex-web-side-chat",
    });
    await this.initializeSideChatThread(response.thread.id);
    return { thread: projectThread(response.thread) };
  }

  private async initializeSideChatThread(threadId: string): Promise<void> {
    try {
      await this.acknowledgedMutation("thread/inject_items", {
        threadId,
        items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "SIDE CHAT BOUNDARY: Only messages after this item are the current task." }] }],
      }, SIDE_CHAT_BOUNDARY_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof OperationUncertainError) throw error;
      await this.cleanupFailedSideChat(threadId);
      throw error;
    }
    try {
      await this.clearGoal(threadId);
    } catch (error) {
      if (error instanceof JsonRpcError && error.message.includes("ephemeral thread does not support goals")) return;
      if (error instanceof OperationUncertainError) throw error;
      await this.cleanupFailedSideChat(threadId);
      throw error;
    }
  }

  private async cleanupFailedSideChat(threadId: string): Promise<void> {
    try {
      await this.unsubscribe(threadId);
    } catch (error) {
      this.emit("warning", new Error("Failed to confirm cleanup for an uninitialized Side Chat", { cause: error }));
      this.failedSideChatCleanupAttempts.set(threadId, 0);
      this.scheduleFailedSideChatCleanup(threadId);
    }
  }

  private scheduleFailedSideChatCleanup(threadId: string): void {
    if (this.failedSideChatCleanupTimers.has(threadId)) return;
    const attempt = this.failedSideChatCleanupAttempts.get(threadId) ?? 0;
    const delay = Math.min(SIDE_CHAT_CLEANUP_RETRY_MAX_MS, SIDE_CHAT_CLEANUP_RETRY_BASE_MS * 2 ** attempt);
    const timer = setTimeout(() => {
      this.failedSideChatCleanupTimers.delete(threadId);
      void this.retryFailedSideChatCleanup(threadId);
    }, delay);
    timer.unref();
    this.failedSideChatCleanupTimers.set(threadId, timer);
  }

  private async retryFailedSideChatCleanup(threadId: string): Promise<void> {
    if (!this.failedSideChatCleanupAttempts.has(threadId)) return;
    try {
      await this.unsubscribe(threadId);
      this.failedSideChatCleanupAttempts.delete(threadId);
    } catch (error) {
      const attempt = (this.failedSideChatCleanupAttempts.get(threadId) ?? 0) + 1;
      this.failedSideChatCleanupAttempts.set(threadId, attempt);
      this.emit("warning", new Error("Retry failed while cleaning up an uninitialized Side Chat", { cause: error }));
      this.scheduleFailedSideChatCleanup(threadId);
    }
  }

  private clearFailedSideChatCleanups(): void {
    for (const timer of this.failedSideChatCleanupTimers.values()) clearTimeout(timer);
    this.failedSideChatCleanupTimers.clear();
    this.failedSideChatCleanupAttempts.clear();
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.acknowledgedMutation("thread/unsubscribe", { threadId });
  }

  async renameSession(threadId: string, name: string): Promise<void> {
    await this.acknowledgedMutation("thread/name/set", { threadId, name });
  }

  async archiveSession(threadId: string): Promise<void> {
    await this.acknowledgedMutation("thread/archive", { threadId });
  }

  async getGoal(threadId: string): Promise<Goal | null> {
    const response = await this.supervisor.transport.request<ThreadGoalGetResponse>("thread/goal/get", { threadId });
    return response.goal ? projectGoal(response.goal) : null;
  }

  async setGoal(params: GoalUpdate): Promise<Goal> {
    const response = await this.acknowledgedMutation<ThreadGoalSetResponse>("thread/goal/set", params as ThreadGoalSetParams);
    return projectGoal(response.goal);
  }

  async clearGoal(threadId: string): Promise<void> {
    await this.acknowledgedMutation("thread/goal/clear", { threadId });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.nonIdempotentMutation("thread/compact/start", { threadId });
  }

  async startReview(threadId: string, target: ReviewTarget): Promise<{ reviewThreadId: string; turn: SessionTurn }> {
    const response = await this.nonIdempotentMutation<ReviewStartResponse>("review/start", { threadId, target, delivery: "inline" });
    return { reviewThreadId: response.reviewThreadId, turn: projectTurn(response.turn) };
  }

  restartForRecovery(): boolean {
    if (this.pendingNonIdempotentMutations > 0 || this.pendingAcknowledgedMutations > 0) return false;
    this.supervisor.retryCurrent();
    return true;
  }

  private async acknowledgedMutation<TResult = unknown>(
    method: string,
    params: unknown,
    timeoutMs = ACKNOWLEDGED_MUTATION_TIMEOUT_MS,
  ): Promise<TResult> {
    this.pendingAcknowledgedMutations += 1;
    try {
      return await this.supervisor.transport.request<TResult>(method, params, acknowledgedMutationTimeout(timeoutMs));
    } catch (error) {
      if (error instanceof JsonRpcMutationResponseTimeoutError || error instanceof JsonRpcMutationConnectionLostError) {
        throw new OperationUncertainError(method, error);
      }
      throw error;
    } finally {
      this.pendingAcknowledgedMutations -= 1;
    }
  }

  private async nonIdempotentMutation<TResult>(method: string, params: unknown): Promise<TResult> {
    this.pendingNonIdempotentMutations += 1;
    try {
      return await this.supervisor.transport.request<TResult>(method, params, NON_IDEMPOTENT_MUTATION_TIMEOUT);
    } catch (error) {
      if (error instanceof JsonRpcMutationResponseTimeoutError || error instanceof JsonRpcMutationConnectionLostError) {
        throw new OperationUncertainError(method, error);
      }
      throw error;
    } finally {
      this.pendingNonIdempotentMutations -= 1;
    }
  }

  respondPendingRequest(requestId: string, allow: boolean, answers: Record<string, string[]> = {}): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) throw new Error("Pending request not found");
    const result = pendingRequestResponse(request, allow, answers);
    this.supervisor.transport.respond(request.id, result);
    this.pendingRequests.delete(requestId);
  }
}

function protocolSourceKind(source: unknown): string {
  if (typeof source === "string") return source;
  if (source && typeof source === "object" && "custom" in source) return String((source as { custom: unknown }).custom);
  return "unknown";
}

function projectGoal(goal: ThreadGoal): Goal {
  return { ...goal };
}
