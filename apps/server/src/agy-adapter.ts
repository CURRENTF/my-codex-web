import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AdapterEvent, AttachmentReference, ListSessionsInput, SessionSettings } from "@codex-web/codex-adapter";
import type { BackendOption, ModelOption, SessionCost, SessionItem, SessionThread, SessionTurn } from "@codex-web/shared-types";
import { AgyProcess, agyQuery } from "./agy-process.js";

interface SavedSession { thread: SessionThread; settings: SessionSettings; nativeId?: string; threadSource: string; archived: boolean }
interface LiveTurn { process: AgyProcess; turn: SessionTurn; stopping: boolean }
const unsupported = (feature: string): never => { throw Object.assign(new Error(`agy 暂不支持 ${feature}`), { statusCode: 400 }); };
function unfinishedToolFailure(turn: SessionTurn, result?: any): string | undefined {
  if (turn.items.some((item) => item.type === "agentMessage" && item.text.trim())) return;
  if (result?.denied_actions?.length) return "agy 操作未获授权；当前 Web 暂不支持 agy 的原生权限审批。";
  const lastTool = turn.items.findLast((item) => item.type === "genericToolCall");
  if (lastTool?.type === "genericToolCall" && lastTool.status === "failed") return "agy 在工具执行失败后结束，未返回最终回复；请展开失败工具查看原因。";
}
export class AgyAdapter extends EventEmitter {
  private records = new Map<string, SavedSession>();
  private live = new Map<string, LiveTurn>();
  private probePromise?: Promise<BackendOption>;
  private catalog?: { at: number; value: BackendOption };
  private disposed = false;
  constructor(private readonly directory: string, private readonly command = "agy") {
    super(); mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".web.json"))) {
      const saved = JSON.parse(readFileSync(path.join(directory, file), "utf8")) as SavedSession;
      if (!/^agy:[0-9a-f-]{36}$/.test(saved.thread?.id)) throw new Error(`Invalid agy metadata: ${file}`);
      for (const turn of saved.thread.turns) if (turn.status === "inProgress") {
        turn.status = "interrupted"; turn.completedAt = Math.floor(Date.now() / 1000);
        for (const item of turn.items) if ("status" in item && item.status === "inProgress") item.status = "interrupted";
      }
      // Older Web versions treated native SUCCESS + empty response as success,
      // even when the final tool was rejected and the agent never replied.
      for (const turn of saved.thread.turns) if (turn.status === "completed") {
        const failure = unfinishedToolFailure(turn);
        if (failure) { turn.status = "failed"; turn.errors = [{ message: failure, code: null, httpStatusCode: null, additionalDetails: null, willRetry: false }]; }
      }
      this.records.set(saved.thread.id, saved);
    }
  }
  async describe(refresh = false): Promise<BackendOption> {
    if (!refresh && this.catalog && Date.now() - this.catalog.at < 30_000) return this.catalog.value;
    this.probePromise ??= this.probe().finally(() => { this.probePromise = undefined; });
    return this.probePromise;
  }
  private async probe(): Promise<BackendOption> {
    try {
      const [list, current] = await Promise.all([agyQuery(this.command, this.directory, ["models"]), agyQuery(this.command, this.directory, ["-p", "/model"])]);
      const models: ModelOption[] = (list?.models ?? []).filter((m: any) => typeof m.id === "string" && m.id).map((m: any) => ({
        id: m.id, model: m.id, displayName: m.label ?? m.id, description: "agy CLI", isDefault: m.id === current?.id,
        defaultReasoning: "default", supportedReasoning: [{ effort: "default", description: "使用 agy 模型默认 effort" }],
        serviceTiers: [], defaultServiceTier: null, inputModalities: ["text"],
      }));
      const value: BackendOption = { id: "agy", name: "agy", models, available: models.length > 0,
        ...(!models.length ? { message: "agy 尚无可用模型，请先在服务所在机器登录 agy。" } : {}) };
      this.catalog = { at: Date.now(), value }; return value;
    } catch (error) { this.catalog = undefined; return { id: "agy", name: "agy", models: [], available: false, message: error instanceof Error ? error.message : "agy 不可用" }; }
  }
  private require(id: string) { const saved = this.records.get(id); if (!saved) throw Object.assign(new Error("agy session not found"), { statusCode: 404 }); return saved; }
  private save(saved: SavedSession) {
    const file = path.join(this.directory, `${saved.thread.id.slice(4)}.web.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(saved), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
  }
  private publish(event: AdapterEvent) { this.emit("event", structuredClone(event)); }
  private assertSettings(settings: Partial<SessionSettings>) {
    if (settings.accessMode && settings.accessMode !== "fullAccess") unsupported("Codex 沙箱权限；agy 使用原生 accept-edits 权限检查");
    if (settings.serviceTier) unsupported("Fast / service tier");
    if (settings.reasoning && settings.reasoning !== "default") unsupported("自定义 effort；使用 agy 模型默认值");
  }
  async startSession(cwd: string, settings: SessionSettings, _ephemeral = false, threadSource = "codex-web") {
    if (this.disposed) throw new Error("agy backend stopped");
    this.assertSettings(settings);
    const catalog = await this.describe();
    if (!catalog.available) throw new Error(catalog.message);
    const model = settings.model ?? (catalog.models.find((m) => m.isDefault) ?? catalog.models[0])?.model;
    if (!catalog.models.some((m) => m.model === model)) throw new Error("agy 模型不可用，请重新选择。");
    const now = Math.floor(Date.now() / 1000), id = `agy:${randomUUID()}`;
    const saved: SavedSession = { thread: { id, cwd, name: null, preview: "", createdAt: now, updatedAt: now, ephemeral: false, forkedFromId: null, turns: [] },
      settings: { backend: "agy", model: model!, reasoning: "default", serviceTier: null, accessMode: "fullAccess" }, threadSource, archived: false };
    this.save(saved); this.records.set(id, saved);
    this.publish({ type: "threadStarted", threadId: id, thread: saved.thread, threadSource });
    return { thread: structuredClone(saved.thread) };
  }
  async readSession(id: string) { return structuredClone(this.require(id).thread); }
  async resumeSession(id: string, settings?: Partial<SessionSettings>) {
    const saved = this.require(id);
    if (!this.live.has(id) && settings) { this.assertSettings(settings); saved.settings = { ...saved.settings, ...settings, backend: "agy" }; this.save(saved); }
    return { thread: structuredClone(saved.thread), settings: { ...saved.settings } };
  }
  async listSessions(input: ListSessionsInput = {}) {
    const cwds = input.cwd ? (Array.isArray(input.cwd) ? input.cwd : [input.cwd]) : null;
    return { data: [...this.records.values()].filter((s) => s.archived === (input.archived ?? false) && (!cwds || cwds.includes(s.thread.cwd))
      && (!input.searchTerm || `${s.thread.name ?? ""} ${s.thread.preview}`.toLowerCase().includes(input.searchTerm.toLowerCase())))
      .map((s) => ({ ...s.thread, sourceKind: "agy", threadSource: s.threadSource }))
      .sort((a, b) => (input.sortDirection === "asc" ? 1 : -1) * (a.updatedAt - b.updatedAt)), nextCursor: null };
  }
  async startTurn(id: string, _cwd: string, text: string, settings: SessionSettings, clientId: string, skills: readonly unknown[] = [], attachments: readonly AttachmentReference[] = []) {
    if (this.disposed) throw new Error("agy backend stopped");
    if (skills.length) unsupported("Web Skill 选择；可使用 agy 原生 Skill 命令");
    if (attachments.some((a) => a.kind === "image")) unsupported("图片附件；当前仅支持文本和文件路径附件");
    if (this.live.has(id)) throw Object.assign(new Error("agy session already running"), { statusCode: 409 });
    this.assertSettings(settings);
    const saved = this.require(id); saved.settings = { ...saved.settings, ...settings, backend: "agy" };
    const turn: SessionTurn = { id: randomUUID(), status: "inProgress", startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null,
      items: [{ type: "userMessage", id: clientId, clientId, content: [{ type: "text", text }] }] };
    saved.thread.turns.push(turn); saved.thread.preview ||= text.slice(0, 160); saved.thread.updatedAt = Math.floor(Date.now() / 1000);
    this.save(saved);
    const process = new AgyProcess(this.command, saved.thread.cwd);
    const live: LiveTurn = { process, turn, stopping: false }; this.live.set(id, live);
    process.on("record", (event) => this.handleRecord(saved, live, event));
    process.on("finished", ({ result, exitOk, failure }) => {
      const interrupted = live.stopping && !failure && result?.status !== "SUCCESS";
      const toolFailure = result?.status === "SUCCESS" ? unfinishedToolFailure(live.turn, result) : undefined;
      const success = !failure && !toolFailure && exitOk && result?.status === "SUCCESS";
      this.finish(saved, live, interrupted ? "interrupted" : success ? "completed" : "failed",
        interrupted || success ? undefined : failure ?? toolFailure ?? (typeof result?.error === "string" ? result.error : "agy 未返回成功的最终结果，请检查 CLI 登录、权限或服务状态。"));
    });
    this.publish({ type: "turnStarted", threadId: id, turn });
    const content = text + (attachments.length ? `\n\nAttached local files:\n${attachments.map((a) => `${a.name}: ${a.path}`).join("\n")}` : "");
    process.start([...(saved.settings.model ? ["--model", saved.settings.model] : []), ...(saved.nativeId ? ["--conversation", saved.nativeId] : [])], content);
    return { turn: structuredClone(turn) };
  }
  private handleRecord(saved: SavedSession, live: LiveTurn, event: any) {
    if (event.event === "init") {
      const nativeId = event.conversation_id;
      if (typeof nativeId !== "string" || !nativeId || (saved.nativeId && saved.nativeId !== nativeId)) throw new Error("agy conversation mismatch");
      saved.nativeId = nativeId; this.save(saved); return;
    }
    if (event.event === "step_update") {
      const step = event.step_update;
      if (!step || !Number.isInteger(step.step_index)) return;
      if (step.conversation_id && step.conversation_id !== saved.nativeId) return;
      const itemId = `${live.turn.id}:${step.step_index}`, existing = live.turn.items.find((i) => i.id === itemId);
      const done = step.state === "DONE" || step.state === "ERROR" || step.state === "CANCELLED";
      if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
        this.upsert(saved, live, { type: "agentMessage", id: itemId, text: (existing?.type === "agentMessage" ? existing.text : "") + step.text_delta }, done);
      } else if (step.step_type === "tool") {
        const tool = step.tool_info;
        const error = typeof tool?.error === "string" ? tool.error : typeof tool?.error?.message === "string" ? tool.error.message : undefined;
        const details = [tool?.parameters ? JSON.stringify(tool.parameters, null, 2) : "", typeof tool?.output === "string" ? tool.output : tool?.output ? JSON.stringify(tool.output) : ""].filter(Boolean).join("\n") || (existing?.type === "genericToolCall" ? existing.details : "");
        this.upsert(saved, live, { type: "genericToolCall", id: itemId, title: tool?.name ?? step.tool_name ?? "agy tool",
          status: step.state === "ERROR" ? "failed" : step.state === "CANCELLED" ? "interrupted" : done ? "completed" : "inProgress",
          details: [details, error ? `错误：${error}` : ""].filter(Boolean).join("\n"),
        }, done);
      }
    }
    if (event.event === "result") {
      // Some versions emit only a final response; preserve it without duplicating streamed messages.
      if (event.result?.response && !live.turn.items.some((i) => i.type === "agentMessage")) this.upsert(saved, live, { type: "agentMessage", id: `${live.turn.id}:response`, text: event.result.response }, true);
    }
  }
  private upsert(saved: SavedSession, live: LiveTurn, item: SessionItem, completed: boolean) {
    const index = live.turn.items.findIndex((i) => i.id === item.id);
    if (index < 0) live.turn.items.push(item); else live.turn.items[index] = item;
    this.publish({ type: "itemUpserted", threadId: saved.thread.id, turnId: live.turn.id, item, completed });
    if (completed) this.save(saved);
  }
  private finish(saved: SavedSession, live: LiveTurn, status: SessionTurn["status"], message?: string) {
    if (this.live.get(saved.thread.id) !== live) return;
    if (message) { const error = { message, code: null, httpStatusCode: null, additionalDetails: null, willRetry: false };
      live.turn.errors = [error]; this.publish({ type: "turnError", threadId: saved.thread.id, turnId: live.turn.id, error }); }
    live.turn.status = status; live.turn.completedAt = Math.floor(Date.now() / 1000);
    live.turn.durationMs = (live.turn.completedAt - (live.turn.startedAt ?? live.turn.completedAt)) * 1000;
    for (const item of live.turn.items) if ("status" in item && item.status === "inProgress") item.status = status;
    saved.thread.updatedAt = Math.floor(Date.now() / 1000); this.save(saved); this.live.delete(saved.thread.id);
    this.publish({ type: "turnCompleted", threadId: saved.thread.id, turn: live.turn });
  }
  async interruptTurn(id: string, turnId: string) { const live = this.live.get(id); if (!live || live.turn.id !== turnId) return; live.stopping = true; await live.process.stop(); }
  async steerTurn(..._args: unknown[]): Promise<{ turnId: string }> { return unsupported("Steer，请将需求排到下一轮"); }
  async compactThread(_id: string): Promise<void> { unsupported("Web 压缩上下文"); }
  async renameSession(id: string, name: string) { const saved = this.require(id); saved.thread.name = name; this.save(saved); this.publish({ type: "nameUpdated", threadId: id, name }); }
  async archiveSession(id: string) { await this.unsubscribe(id); const saved = this.require(id); saved.archived = true; this.save(saved); }
  async unsubscribe(id: string) { if (this.live.has(id)) throw new Error("Cannot unload active agy session"); }
  async getGoal(_id: string) { return null; }
  async readSessionCost(id: string): Promise<SessionCost> { this.require(id); return { threadId: id, status: "unsupported", source: "agy", estimatedUsd: null, groups: [], notes: ["agy CLI 未提供可靠的会话美元费用。"] }; }
  async generateSessionTitle(_cwd: string, text: string, _outcome?: string) { return text.trim().slice(0, 48) || null; }
  async stop() { this.disposed = true; await Promise.all([...this.live.values()].map((live) => { live.stopping = true; return live.process.stop(); })); }
}
