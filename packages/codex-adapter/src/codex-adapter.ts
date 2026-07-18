import { EventEmitter } from "node:events";
import type { AccessMode, Goal, ModelOption, SessionThread, SessionTurn } from "@codex-web/shared-types";
import type { Account } from "@codex-web/codex-schema/v2/Account";
import type { GetAccountResponse } from "@codex-web/codex-schema/v2/GetAccountResponse";
import type { ModelListResponse } from "@codex-web/codex-schema/v2/ModelListResponse";
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
import { JsonRpcError, type RpcServerRequest } from "./json-rpc-transport.js";
import { projectAdapterEvent } from "./adapter-events.js";
import { pendingRequestResponse, projectPendingRequest } from "./pending-requests.js";
import { CodexProcessSupervisor } from "./supervisor.js";
import { projectThread, projectTurn } from "./ui-projection.js";

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
  createdAt: number; updatedAt: number; forkedFromId: string | null;
}

export interface GoalUpdate {
  threadId: string; objective?: string; status?: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"; tokenBudget?: number | null;
}

const SIDE_CHAT_INSTRUCTIONS = `You are in a side chat forked from a parent Codex session. The parent history is reference context only. Do not continue the parent task or plan. Only messages after the side-chat boundary define the current task. Default to explanation and lightweight exploration. Modify files only when the side-chat user explicitly asks. Do not start, steer, or control subagents belonging to the parent session.`;

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

  stop(): void { this.supervisor.stop(); }

  async initialize(): Promise<void> {
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
    this.accountCheckPromise ??= this.readAccount().then((account) => {
      this.accountValue = account.account;
      this.accountChecked = true;
    });
    return this.accountCheckPromise;
  }

  async listModels(): Promise<ModelOption[]> {
    const response = await this.supervisor.transport.request<ModelListResponse>("model/list", { limit: 100, includeHidden: false });
    return response.data.filter((model) => !model.hidden).map((model) => ({
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

  async listSessions(input: ListSessionsInput = {}): Promise<{ data: ListedSession[]; nextCursor: string | null }> {
    const response = await this.supervisor.transport.request<ThreadListResponse>("thread/list", {
      cursor: input.cursor ?? null,
      limit: input.limit ?? 100,
      sortKey: "updated_at",
      sortDirection: input.sortDirection ?? "desc",
      sourceKinds: ["cli", "vscode", "appServer"],
      archived: false,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.searchTerm ? { searchTerm: input.searchTerm } : {}),
    });
    return { data: response.data.map((thread) => ({ id: thread.id, preview: thread.preview, name: thread.name, cwd: thread.cwd, sourceKind: protocolSourceKind(thread.source), createdAt: thread.createdAt, updatedAt: thread.updatedAt, forkedFromId: thread.forkedFromId })), nextCursor: response.nextCursor };
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

  async startSession(cwd: string, settings: SessionSettings, ephemeral = false): Promise<{ thread: SessionThread }> {
    const response = await this.supervisor.transport.request<ThreadStartResponse>("thread/start", {
      cwd,
      model: settings.model ?? null,
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandbox: sandboxMode(settings.accessMode),
      ...(reasoningConfig(settings) ? { config: reasoningConfig(settings) } : {}),
      ephemeral,
      threadSource: "codex-web",
    });
    return { thread: projectThread(response.thread) };
  }

  async startTurn(threadId: string, cwd: string, text: string, settings: SessionSettings, clientUserMessageId: string): Promise<{ turn: SessionTurn }> {
    const response = await this.supervisor.transport.request<TurnStartResponse>("turn/start", {
      threadId,
      clientUserMessageId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd,
      model: settings.model ?? null,
      effort: settings.reasoning ?? null,
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandboxPolicy: sandboxPolicy(settings.accessMode, cwd),
    });
    return { turn: projectTurn(response.turn) };
  }

  async steerTurn(threadId: string, expectedTurnId: string, text: string, clientUserMessageId: string): Promise<{ turnId: string }> {
    return this.supervisor.transport.request("turn/steer", {
      threadId,
      expectedTurnId,
      clientUserMessageId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.supervisor.transport.request("turn/interrupt", { threadId, turnId });
  }

  async forkSession(threadId: string, lastTurnId: string | null, settings: SessionSettings, ephemeral = false, cwd = this.options.cwd): Promise<{ thread: SessionThread }> {
    const response = await this.supervisor.transport.request<ThreadForkResponse>("thread/fork", {
      threadId,
      ...(lastTurnId ? { lastTurnId } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      cwd,
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandbox: sandboxMode(settings.accessMode),
      ...(reasoningConfig(settings) ? { config: reasoningConfig(settings) } : {}),
      ephemeral,
      threadSource: "codex-web",
    });
    return { thread: projectThread(response.thread) };
  }

  async createSideChat(threadId: string, lastTurnId: string | null, settings: SessionSettings, cwd = this.options.cwd): Promise<{ thread: SessionThread }> {
    const response = await retryThreadMaterialization(() => this.supervisor.transport.request<ThreadForkResponse>("thread/fork", {
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
    const response = await this.supervisor.transport.request<ThreadStartResponse>("thread/start", {
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
      await this.supervisor.transport.request("thread/inject_items", {
        threadId,
        items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "SIDE CHAT BOUNDARY: Only messages after this item are the current task." }] }],
      }, 15_000);
    } catch (error) {
      await this.unsubscribe(threadId).catch(() => undefined);
      throw error;
    }
    try {
      await this.clearGoal(threadId);
    } catch (error) {
      if (error instanceof JsonRpcError && error.message.includes("ephemeral thread does not support goals")) return;
      await this.unsubscribe(threadId).catch(() => undefined);
      throw error;
    }
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.supervisor.transport.request("thread/unsubscribe", { threadId });
  }

  async renameSession(threadId: string, name: string): Promise<void> {
    await this.supervisor.transport.request("thread/name/set", { threadId, name });
  }

  async archiveSession(threadId: string): Promise<void> {
    await this.supervisor.transport.request("thread/archive", { threadId });
  }

  async getGoal(threadId: string): Promise<Goal | null> {
    const response = await this.supervisor.transport.request<ThreadGoalGetResponse>("thread/goal/get", { threadId });
    return response.goal ? projectGoal(response.goal) : null;
  }

  async setGoal(params: GoalUpdate): Promise<Goal> {
    const response = await this.supervisor.transport.request<ThreadGoalSetResponse>("thread/goal/set", params as ThreadGoalSetParams);
    return projectGoal(response.goal);
  }

  async clearGoal(threadId: string): Promise<void> {
    await this.supervisor.transport.request("thread/goal/clear", { threadId });
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
