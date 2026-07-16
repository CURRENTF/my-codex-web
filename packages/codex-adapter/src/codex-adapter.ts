import { EventEmitter } from "node:events";
import type { AccessMode, ModelOption } from "@codex-web/shared-types";
import type { Account } from "@codex-web/codex-schema/v2/Account";
import type { GetAccountResponse } from "@codex-web/codex-schema/v2/GetAccountResponse";
import type { ModelListResponse } from "@codex-web/codex-schema/v2/ModelListResponse";
import type { Thread } from "@codex-web/codex-schema/v2/Thread";
import type { ThreadForkResponse } from "@codex-web/codex-schema/v2/ThreadForkResponse";
import type { ThreadGoal } from "@codex-web/codex-schema/v2/ThreadGoal";
import type { ThreadGoalGetResponse } from "@codex-web/codex-schema/v2/ThreadGoalGetResponse";
import type { ThreadGoalSetParams } from "@codex-web/codex-schema/v2/ThreadGoalSetParams";
import type { ThreadGoalSetResponse } from "@codex-web/codex-schema/v2/ThreadGoalSetResponse";
import type { ThreadListResponse } from "@codex-web/codex-schema/v2/ThreadListResponse";
import type { ThreadReadResponse } from "@codex-web/codex-schema/v2/ThreadReadResponse";
import type { ThreadStartResponse } from "@codex-web/codex-schema/v2/ThreadStartResponse";
import type { TurnStartResponse } from "@codex-web/codex-schema/v2/TurnStartResponse";
import type { RpcServerRequest } from "./json-rpc-transport.js";
import { CodexProcessSupervisor } from "./supervisor.js";

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
  model?: string | null;
  reasoning?: string | null;
  accessMode: AccessMode;
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

export class CodexAdapter extends EventEmitter {
  readonly supervisor: CodexProcessSupervisor;
  private ready = false;
  private accountValue: Account | null = null;
  private modelsValue: ModelOption[] = [];

  constructor(private readonly options: AdapterOptions) {
    super();
    this.supervisor = new CodexProcessSupervisor({
      command: options.codexCommand,
      cwd: options.cwd,
      codexHome: options.codexHome,
    });
    this.supervisor.on("notification", (message) => this.emit("notification", message));
    this.supervisor.on("serverRequest", (request) => this.emit("serverRequest", request));
    this.supervisor.on("stderr", (line) => this.emit("stderr", line));
    this.supervisor.on("disconnected", (details) => {
      this.ready = false;
      this.emit("connection", { state: "disconnected", details });
    });
    this.supervisor.on("restart", () => void this.initialize().catch((error) => this.emit("error", error)));
  }

  get connected(): boolean { return this.ready; }
  get account(): Account | null { return this.accountValue; }
  get models(): ModelOption[] { return this.modelsValue; }

  async start(): Promise<void> {
    await this.supervisor.start();
    await this.initialize();
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
    const [account, models] = await Promise.all([this.readAccount(), this.listModels()]);
    this.accountValue = account.account;
    this.modelsValue = models;
    this.ready = true;
    this.supervisor.markReady();
    this.emit("connection", { state: "connected" });
  }

  async readAccount(): Promise<GetAccountResponse> {
    return this.supervisor.transport.request<GetAccountResponse>("account/read", { refreshToken: false });
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

  async listSessions(input: ListSessionsInput = {}): Promise<ThreadListResponse> {
    return this.supervisor.transport.request("thread/list", {
      cursor: input.cursor ?? null,
      limit: input.limit ?? 100,
      sortKey: "updated_at",
      sortDirection: input.sortDirection ?? "desc",
      sourceKinds: ["cli", "vscode", "appServer"],
      archived: false,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.searchTerm ? { searchTerm: input.searchTerm } : {}),
    });
  }

  async readSession(threadId: string): Promise<Thread> {
    const response = await this.supervisor.transport.request<ThreadReadResponse>("thread/read", { threadId, includeTurns: true });
    return response.thread;
  }

  async resumeSession(threadId: string, settings?: Partial<SessionSettings>): Promise<Thread> {
    const response = await this.supervisor.transport.request<{ thread: Thread }>("thread/resume", {
      threadId,
      ...(settings?.model ? { model: settings.model } : {}),
      ...(settings?.accessMode ? { approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request", sandbox: sandboxMode(settings.accessMode) } : {}),
    });
    return response.thread;
  }

  async startSession(cwd: string, settings: SessionSettings, ephemeral = false): Promise<ThreadStartResponse> {
    return this.supervisor.transport.request("thread/start", {
      cwd,
      model: settings.model ?? null,
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandbox: sandboxMode(settings.accessMode),
      ephemeral,
      threadSource: "codex-web",
    });
  }

  async startTurn(threadId: string, cwd: string, text: string, settings: SessionSettings, clientUserMessageId: string): Promise<TurnStartResponse> {
    return this.supervisor.transport.request("turn/start", {
      threadId,
      clientUserMessageId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd,
      model: settings.model ?? null,
      effort: settings.reasoning ?? null,
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandboxPolicy: sandboxPolicy(settings.accessMode, cwd),
    });
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

  async forkSession(threadId: string, lastTurnId: string | null, settings: SessionSettings, ephemeral = false, cwd = this.options.cwd): Promise<ThreadForkResponse> {
    return this.supervisor.transport.request("thread/fork", {
      threadId,
      ...(lastTurnId ? { lastTurnId } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      cwd,
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandbox: sandboxMode(settings.accessMode),
      ephemeral,
      threadSource: "codex-web",
    });
  }

  async createSideChat(threadId: string, lastTurnId: string | null, settings: SessionSettings, cwd = this.options.cwd): Promise<ThreadForkResponse> {
    const response = await this.supervisor.transport.request<ThreadForkResponse>("thread/fork", {
      threadId,
      ...(lastTurnId ? { lastTurnId } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      cwd,
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandbox: sandboxMode(settings.accessMode),
      ephemeral: true,
      developerInstructions: SIDE_CHAT_INSTRUCTIONS,
      threadSource: "codex-web-side-chat",
    });
    await this.supervisor.transport.request("thread/inject_items", {
      threadId: response.thread.id,
      items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "SIDE CHAT BOUNDARY: Only messages after this item are the current task." }] }],
    }, 5_000).catch((error) => this.emit("warning", { method: "thread/inject_items", error }));
    await this.clearGoal(response.thread.id).catch(() => undefined);
    return response;
  }

  async createEmptySideChat(cwd: string, settings: SessionSettings): Promise<ThreadStartResponse> {
    const response = await this.supervisor.transport.request<ThreadStartResponse>("thread/start", {
      cwd,
      ...(settings.model ? { model: settings.model } : {}),
      approvalPolicy: settings.accessMode === "fullAccess" ? "never" : "on-request",
      sandbox: sandboxMode(settings.accessMode),
      ephemeral: true,
      developerInstructions: SIDE_CHAT_INSTRUCTIONS,
      threadSource: "codex-web-side-chat",
    });
    return response;
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

  async getGoal(threadId: string): Promise<ThreadGoal | null> {
    const response = await this.supervisor.transport.request<ThreadGoalGetResponse>("thread/goal/get", { threadId });
    return response.goal;
  }

  async setGoal(params: ThreadGoalSetParams): Promise<ThreadGoal> {
    const response = await this.supervisor.transport.request<ThreadGoalSetResponse>("thread/goal/set", params);
    return response.goal;
  }

  async clearGoal(threadId: string): Promise<void> {
    await this.supervisor.transport.request("thread/goal/clear", { threadId });
  }

  respondToServerRequest(request: RpcServerRequest, result: unknown): void {
    this.supervisor.transport.respond(request.id, result);
  }
}
