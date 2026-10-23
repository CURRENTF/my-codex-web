import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterEvent, AdapterPendingRequest, AttachmentReference, ListSessionsInput, SessionSettings } from "@codex-web/codex-adapter";
import type { BackendOption, ModelOption, SessionItem, SessionThread, SessionTurn } from "@codex-web/shared-types";
import { PiRpc } from "./pi-rpc.js";

interface SavedSession {
  thread: SessionThread;
  settings: SessionSettings;
  nativeFile: string;
  threadSource: string;
  archived: boolean;
}
interface LiveSession {
  rpc: PiRpc;
  turn?: SessionTurn;
  messageId?: string;
  customMessageId?: string;
  stopping?: boolean;
  closed?: boolean;
}
const unsupported = (feature: string): never => { throw Object.assign(new Error(`pi 暂不支持 ${feature}`), { statusCode: 400 }); };
const textContent = (content: any): string => Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") : "";

export class PiAdapter extends EventEmitter {
  private readonly records = new Map<string, SavedSession>();
  private readonly live = new Map<string, LiveSession>();
  private readonly loading = new Map<string, Promise<LiveSession>>();
  private readonly questions = new Map<string, { rpc: PiRpc; nativeId: string; method: string; threadId: string }>();
  private modelsValue: ModelOption[] = [];
  private probePromise?: Promise<BackendOption>;
  private disposed = false;
  constructor(private readonly directory: string, private readonly command?: string) {
    super();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".web.json"))) {
      const saved = JSON.parse(readFileSync(path.join(directory, name), "utf8")) as SavedSession;
      if (!/^pi:[0-9a-f-]{36}$/.test(saved.thread?.id)) throw new Error(`Invalid Pi session metadata: ${name}`);
      for (const turn of saved.thread.turns) if (turn.status === "inProgress") {
        turn.status = "interrupted"; turn.completedAt = Math.floor(Date.now() / 1000);
        for (const item of turn.items) if ("status" in item && item.status === "inProgress") item.status = "interrupted";
      }
      this.records.set(saved.thread.id, saved);
    }
  }
  get models(): ModelOption[] { return this.modelsValue; }
  async describe(): Promise<BackendOption> {
    this.probePromise ??= this.probe().finally(() => { this.probePromise = undefined; });
    return this.probePromise;
  }
  private async probe(): Promise<BackendOption> {
    const rpc = new PiRpc(this.directory, ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates"], this.command);
    rpc.on("failure", () => undefined);
    try {
      rpc.start();
      const [result, state] = await Promise.all([rpc.request("get_available_models", {}, 5_000), rpc.request("get_state", {}, 5_000)]);
      this.modelsValue = (result.models ?? []).map((model: any): ModelOption => ({
        id: `${model.provider}/${model.id}`, model: `${model.provider}/${model.id}`,
        displayName: `${model.name ?? model.id} · ${model.provider}`, description: "pi",
        isDefault: state.model?.provider === model.provider && state.model?.id === model.id,
        defaultReasoning: model.reasoning ? "medium" : "off",
        supportedReasoning: (model.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"]).map((effort) => ({ effort })),
        serviceTiers: [], defaultServiceTier: null, inputModalities: model.input ?? ["text"],
      }));
      return { id: "pi", name: "pi", available: this.models.length > 0, models: this.models,
        ...(this.models.length ? {} : { message: "pi 尚无可用模型。请在服务所在机器配置 pi 的 API Key 或通过 pi /login 登录。" }) };
    } catch (error) {
      return { id: "pi", name: "pi", available: false, models: [], message: error instanceof Error ? error.message : "无法启动 pi" };
    } finally { rpc.stop(); }
  }
  async startSession(cwd: string, settings: SessionSettings, _ephemeral = false, threadSource = "codex-web") {
    this.assertSettings(settings);
    const id = `pi:${randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    const saved: SavedSession = {
      thread: { id, cwd, name: null, preview: "", createdAt: now, updatedAt: now, ephemeral: false, forkedFromId: null, turns: [] },
      settings: { ...settings, backend: "pi", serviceTier: null }, nativeFile: path.join(this.directory, `${id.slice(3)}.jsonl`), threadSource, archived: false,
    };
    this.records.set(id, saved);
    try { await this.ensureLive(id); this.save(saved); }
    catch (error) { this.live.get(id)?.rpc.stop(); this.live.delete(id); this.records.delete(id); throw error; }
    this.publish({ type: "threadStarted", threadId: id, thread: structuredClone(saved.thread), threadSource });
    return { thread: structuredClone(saved.thread) };
  }
  private require(id: string): SavedSession {
    const saved = this.records.get(id);
    if (!saved) throw Object.assign(new Error("Pi session not found"), { statusCode: 404 });
    return saved;
  }
  private save(saved: SavedSession): void {
    const file = path.join(this.directory, `${saved.thread.id.slice(3)}.web.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(saved), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
  }
  private publish(event: AdapterEvent): void { this.emit("event", structuredClone(event)); }
  private async ensureLive(id: string): Promise<LiveSession> {
    const existing = this.live.get(id); if (existing) return existing;
    const pending = this.loading.get(id); if (pending) return pending;
    const loading = this.open(id).finally(() => this.loading.delete(id));
    this.loading.set(id, loading); return loading;
  }
  private async open(id: string): Promise<LiveSession> {
    if (this.disposed) throw new Error("Pi backend stopped");
    const saved = this.require(id);
    const rpc = new PiRpc(saved.thread.cwd, ["--session", saved.nativeFile], this.command);
    const live: LiveSession = { rpc };
    rpc.on("record", (record) => {
      try { this.handleRecord(id, live, record); }
      catch { rpc.stop(); this.finish(id, live, "failed", "Unable to save Pi session output"); }
    });
    rpc.on("failure", (error: Error) => {
      live.closed = true;
      this.finish(id, live, "failed", error.message);
      if (this.live.get(id) === live) this.live.delete(id);
      this.clearQuestions(id);
    });
    try {
      rpc.start();
      const state = await rpc.request("get_state");
      const { commands } = await rpc.request("get_commands");
      if (!commands?.some((command: { name: string }) => command.name === "unified-exec-sessions")) {
        throw new Error("pi-unified-exec 未加载，请运行 npm run setup 安装锁定依赖，并检查 Pi 扩展兼容性。");
      }
      // Restore the native session; never feed UI projections back as model context.
      if (!saved.settings.model && state.model) saved.settings.model = `${state.model.provider}/${state.model.id}`;
      if (!saved.settings.model) throw new Error("Pi 尚无默认模型，请先配置 pi 的模型与凭证。");
      if (!saved.settings.reasoning) saved.settings.reasoning = state.thinkingLevel ?? "off";
      await this.applySettings(saved, live, saved.settings);
      if (this.disposed) throw new Error("Pi backend stopped");
      this.live.set(id, live); return live;
    } catch (error) { live.closed = true; rpc.stop(); throw error; }
  }
  private assertSettings(settings: Partial<SessionSettings>): void {
    if (settings.accessMode && settings.accessMode !== "fullAccess") unsupported("只读或工作区沙箱；pi 当前以 Full Access 执行");
    if (settings.serviceTier) unsupported("Fast / service tier");
  }
  private async applySettings(saved: SavedSession, live: LiveSession, settings: Partial<SessionSettings>): Promise<void> {
    this.assertSettings(settings);
    if (settings.model) {
      const slash = settings.model.indexOf("/");
      if (slash < 1) throw new Error("Pi model must include its provider");
      await live.rpc.request("set_model", { provider: settings.model.slice(0, slash), modelId: settings.model.slice(slash + 1) });
    }
    if (settings.reasoning) {
      const levels = await live.rpc.request("get_available_thinking_levels");
      if (!levels.levels?.includes(settings.reasoning)) throw new Error(`Pi model does not support reasoning level: ${settings.reasoning}`);
      await live.rpc.request("set_thinking_level", { level: settings.reasoning });
    }
    saved.settings = { ...saved.settings, ...settings, backend: "pi", serviceTier: null, accessMode: "fullAccess" };
  }
  async readSession(id: string) { return structuredClone(this.require(id).thread); }
  async resumeSession(id: string, settings?: Partial<SessionSettings>) {
    const saved = this.require(id); const live = await this.ensureLive(id);
    if (!live.turn && settings) { await this.applySettings(saved, live, settings); this.save(saved); }
    return { thread: structuredClone(saved.thread), settings: { ...saved.settings } };
  }
  async listSessions(input: ListSessionsInput = {}) {
    const cwd = input.cwd ? (Array.isArray(input.cwd) ? input.cwd : [input.cwd]) : null;
    const data = [...this.records.values()].filter((saved) => saved.archived === (input.archived ?? false)
      && (!cwd || cwd.includes(saved.thread.cwd))
      && (!input.searchTerm || `${saved.thread.name ?? ""} ${saved.thread.preview}`.toLowerCase().includes(input.searchTerm.toLowerCase())))
      .map((saved) => ({ ...saved.thread, sourceKind: "pi", threadSource: saved.threadSource }))
      .sort((a, b) => (input.sortDirection === "asc" ? 1 : -1) * (a.updatedAt - b.updatedAt));
    return { data, nextCursor: null };
  }
  private async promptInput(text: string, attachments: readonly AttachmentReference[]) {
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    const files: string[] = [];
    for (const attachment of attachments) {
      if (attachment.kind === "image") {
        const ext = path.extname(attachment.path).toLowerCase();
        const mimeType = ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[ext];
        if (!mimeType) throw new Error("Pi image type is unsupported");
        images.push({ type: "image", mimeType, data: (await readFile(attachment.path)).toString("base64") });
      } else files.push(`${attachment.name}: ${attachment.path}`);
    }
    return { message: text + (files.length ? `\n\nAttached local files:\n${files.join("\n")}` : ""), ...(images.length ? { images } : {}) };
  }
  async startTurn(id: string, _cwd: string, text: string, settings: SessionSettings, clientId: string, skills: readonly unknown[] = [], attachments: readonly AttachmentReference[] = []) {
    if (skills.length) unsupported("Web Skill 选择；可使用 pi 自己的 /skill 命令");
    const saved = this.require(id); const live = await this.ensureLive(id);
    if (live.turn) throw new Error("Pi session already has an active turn");
    await this.applySettings(saved, live, settings);
    const input = await this.promptInput(text, attachments);
    // An extension may start a run while settings/attachments are being prepared.
    if (live.turn) throw Object.assign(new Error("Pi session already has an active turn"), { statusCode: 409 });
    saved.thread.preview ||= text.slice(0, 160);
    const turn = this.beginTurn(id, live, [{ type: "userMessage", id: clientId, clientId, content: [{ type: "text", text }] }]);
    try {
      const result = await live.rpc.request("prompt", input);
      if (result?.disposition === "handled" && live.turn === turn) this.finish(id, live, "completed");
    } catch (error) { if (live.turn === turn) this.finish(id, live, "failed", error instanceof Error ? error.message : "Pi prompt failed"); throw error; }
    return { turn: structuredClone(turn) };
  }
  async steerTurn(id: string, expectedTurnId: string, text: string, clientId: string, skills: readonly unknown[] = [], attachments: readonly AttachmentReference[] = []) {
    if (skills.length) unsupported("Web Skill 选择");
    const live = this.live.get(id);
    if (!live?.turn || live.turn.id !== expectedTurnId) throw Object.assign(new Error("Pi turn has already finished"), { statusCode: 409 });
    const input = await this.promptInput(text, attachments);
    await live.rpc.request("steer", input);
    if (live.turn?.id === expectedTurnId) this.upsert(id, live, { type: "userMessage", id: clientId, clientId, content: [{ type: "text", text }] }, true);
    return { turnId: expectedTurnId };
  }
  async interruptTurn(id: string, turnId: string) {
    const live = this.live.get(id); if (!live?.turn || live.turn.id !== turnId) return;
    live.stopping = true;
    await live.rpc.request("clear_queue"); await live.rpc.request("abort");
    if (live.turn?.id === turnId) this.finish(id, live, "interrupted");
  }
  async compactThread(id: string) { const live = await this.ensureLive(id); await live.rpc.request("compact", {}, 120_000); }
  async renameSession(id: string, name: string) {
    const saved = this.require(id); const live = await this.ensureLive(id);
    await live.rpc.request("set_session_name", { name }); saved.thread.name = name; this.save(saved);
    this.publish({ type: "nameUpdated", threadId: id, name });
  }
  async archiveSession(id: string) { const saved = this.require(id); saved.archived = true; this.save(saved); await this.unsubscribe(id); }
  async unsubscribe(id: string) { const live = this.live.get(id); if (live?.turn) throw new Error("Cannot unload an active Pi session"); if (live) { live.closed = true; live.rpc.stop(); } this.live.delete(id); this.clearQuestions(id); }
  async getGoal(_id: string) { return null; }
  async readSessionCost(id: string): Promise<import("@codex-web/shared-types").SessionCost> {
    const live = await this.ensureLive(id);
    const stats = await live.rpc.request("get_session_stats");
    return { threadId: id, source: "pi", status: typeof stats.cost === "number" ? "available" : "unavailable",
      estimatedUsd: typeof stats.cost === "number" ? stats.cost.toFixed(6) : null, groups: [],
      notes: ["按 pi 配置的模型价格估算；本地模型或未配置价格的模型可能显示 0。"] };
  }
  async generateSessionTitle(_cwd: string, userRequest: string, _outcome?: string) { return userRequest.trim().slice(0, 48) || null; }
  stop() { this.disposed = true; for (const [id, live] of this.live) { this.finish(id, live, "interrupted"); live.rpc.stop(); } this.live.clear(); }
  private beginTurn(id: string, live: LiveSession, items: SessionItem[] = []): SessionTurn {
    const turn: SessionTurn = { id: randomUUID(), status: "inProgress", startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null, items };
    const saved = this.require(id);
    saved.thread.turns.push(turn); saved.thread.updatedAt = Math.floor(Date.now() / 1000);
    live.turn = turn; live.messageId = undefined; live.customMessageId = undefined; live.stopping = false;
    this.save(saved); this.publish({ type: "turnStarted", threadId: id, turn });
    return turn;
  }
  private upsert(id: string, live: LiveSession, item: SessionItem, completed: boolean) {
    if (!live.turn) return;
    const index = live.turn.items.findIndex((existing) => existing.id === item.id);
    if (index >= 0) live.turn.items[index] = item; else live.turn.items.push(item);
    this.publish({ type: "itemUpserted", threadId: id, turnId: live.turn.id, item, completed });
    if (completed) this.save(this.require(id));
  }
  private finish(id: string, live: LiveSession, status: SessionTurn["status"], message?: string) {
    const turn = live.turn; if (!turn) return;
    if (message) {
      const error = { message, code: null, httpStatusCode: null, additionalDetails: null, willRetry: false };
      turn.errors = [...(turn.errors ?? []), error]; this.publish({ type: "turnError", threadId: id, turnId: turn.id, error });
    }
    turn.status = live.stopping ? "interrupted" : (turn.errors?.length ? "failed" : status);
    turn.completedAt = Math.floor(Date.now() / 1000); turn.durationMs = (turn.completedAt - (turn.startedAt ?? turn.completedAt)) * 1000;
    for (const item of turn.items) if ("status" in item && item.status === "inProgress") item.status = turn.status;
    const saved = this.require(id); saved.thread.updatedAt = Math.floor(Date.now() / 1000); this.save(saved);
    live.turn = undefined; live.messageId = undefined; live.customMessageId = undefined; this.clearQuestions(id);
    this.publish({ type: "turnCompleted", threadId: id, turn });
    if (!this.disposed) void live.rpc.request("get_session_stats").then((stats) => {
      if (stats.contextUsage) this.publish({ type: "tokenUsageUpdated", threadId: id,
        contextUsage: { usedTokens: stats.contextUsage.tokens ?? 0, maxTokens: stats.contextUsage.contextWindow ?? null } });
    }).catch(() => undefined);
  }
  private clearQuestions(id: string) {
    for (const [requestId, request] of this.questions) if (request.threadId === id) {
      this.questions.delete(requestId); this.publish({ type: "serverRequestResolved", requestId });
    }
  }
  respondPendingRequest(id: string, allow: boolean, answers: Record<string, string[]> = {}) {
    const request = this.questions.get(id); if (!request) throw new Error("Pi request not found");
    const value = answers.answer?.[0];
    request.rpc.send({ type: "extension_ui_response", id: request.nativeId,
      ...(request.method === "confirm" ? { confirmed: allow && value === "允许" } : allow && value !== undefined ? { value } : { cancelled: true }) });
    this.questions.delete(id); this.publish({ type: "serverRequestResolved", requestId: id });
  }
  private handleRecord(id: string, live: LiveSession, event: any) {
    if (this.disposed || live.closed) return;
    // Pi extensions can start a new native run without a Web prompt. Repeated
    // agent_start events within retries/follow-ups belong to the existing turn.
    if (event.type === "agent_start" && !live.turn) this.beginTurn(id, live);
    if (event.type === "extension_ui_request") {
      if (!["confirm", "select", "input", "editor"].includes(event.method)) return;
      const requestId = `pi-request:${randomUUID()}`;
      this.questions.set(requestId, { rpc: live.rpc, nativeId: event.id, method: event.method, threadId: id });
      const options: string[] | null = event.method === "confirm" ? ["允许", "拒绝"] : event.options ?? null;
      const request: AdapterPendingRequest = { id: requestId, threadId: id, summary: { id: requestId, method: "item/tool/requestUserInput", params: {
        type: "userInput", isBlocking: true, autoResolutionMs: null,
        questions: [{ id: "answer", header: "pi", question: [event.title, event.message].filter(Boolean).join("\n") || "pi 请求输入", isOther: event.method !== "confirm", isSecret: false,
          options: options?.map((label) => ({ label, description: "" })) ?? null }],
      } } };
      this.emit("pendingRequest", request); return;
    }
    if (!live.turn) return;
    if (event.type === "agent_settled") { this.finish(id, live, event.aborted ? "interrupted" : "completed"); return; }
    if (["message_start", "message_end"].includes(event.type) && event.message?.role === "custom" && event.message.display === true) {
      const message = event.message;
      const itemId = live.customMessageId ??= randomUUID();
      // Keep extension metadata distinct from human instructions and assistant output.
      this.upsert(id, live, { type: "genericToolCall", id: itemId, title: `pi · ${message.customType ?? "extension"}`,
        status: "completed", details: typeof message.content === "string" ? message.content : textContent(message.content) }, event.type === "message_end");
      if (event.type === "message_end") live.customMessageId = undefined;
    }
    if (event.type === "message_start" && event.message?.role === "assistant") live.messageId = randomUUID();
    if (["message_update", "message_end"].includes(event.type) && event.message?.role === "assistant") {
      const messageId = live.messageId ??= randomUUID();
      const message = event.message;
      const text = textContent(message.content);
      if (text) this.upsert(id, live, { type: "agentMessage", id: messageId, text }, event.type === "message_end");
      const thinking = (message.content ?? []).filter((part: any) => part.type === "thinking").map((part: any) => part.thinking ?? "");
      if (thinking.length) this.upsert(id, live, { type: "reasoning", id: `${messageId}:thinking`, summary: thinking }, event.type === "message_end");
      if (event.type === "message_end") {
        if (message.stopReason === "error") {
          const error = { message: message.errorMessage || "Pi provider request failed", code: null, httpStatusCode: null, additionalDetails: null, willRetry: false };
          live.turn.errors = [error]; this.publish({ type: "turnError", threadId: id, turnId: live.turn.id, error });
        } else if (message.stopReason === "aborted") live.stopping = true;
        else live.turn.errors = [];
        live.messageId = undefined;
      }
    }
    if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) {
      const toolId = event.toolCallId;
      if (typeof toolId !== "string") return;
      const existing = live.turn.items.find((item) => item.id === toolId);
      const ended = event.type === "tool_execution_end";
      const result = event.result ?? event.partialResult;
      const output = result ? textContent(result.content) : "";
      const toolName = event.toolName ?? (existing?.type === "genericToolCall" ? existing.title : "tool");
      this.upsert(id, live, { type: "genericToolCall", id: toolId, title: toolName,
        status: ended ? (event.isError ? "failed" : "completed") : "inProgress",
        details: output || (event.args ? JSON.stringify(event.args, null, 2) : existing?.type === "genericToolCall" ? existing.details : ""),
      }, ended);
    }
  }
}
export { unsupported as unsupportedPiFeature };
