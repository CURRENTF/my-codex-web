import { EventEmitter } from "node:events";
import { CodexAdapter, type SessionSettings } from "@codex-web/codex-adapter";
import { sessionBackend, type BackendOption } from "@codex-web/shared-types";
import { PiAdapter, unsupportedPiFeature } from "./pi-adapter.js";

/** The service consumes operations, never the Codex transport or process supervisor. */
export type AgentBackend = Pick<CodexAdapter,
  "readSession" | "resumeSession" | "startSession" | "startTurn" | "steerTurn" | "interruptTurn" |
  "listSessions" | "listSkills" | "readSessionCost" | "renameSession" | "archiveSession" | "unsubscribe" |
  "forkSession" | "createSideChat" | "createEmptySideChat" | "getGoal" | "setGoal" | "clearGoal" |
  "compactThread" | "startReview" | "respondPendingRequest" | "restartForRecovery"> & {
  generateSessionTitle(cwd: string, userRequest: string, assistantOutcome: string, threadId?: string): Promise<string | null>;
};

export class BackendRouter extends EventEmitter implements AgentBackend {
  constructor(readonly codex: CodexAdapter, readonly pi: PiAdapter) {
    super();
    for (const source of [codex, pi]) for (const event of ["event", "pendingRequest", "stderr", "warning", "error"]) {
      source.on(event, (...args) => this.emit(event, ...args));
    }
    codex.on("connection", (event) => this.emit("connection", event));
  }
  get account() { return this.codex.account; }
  get models() { return this.codex.models; }
  async describe(): Promise<BackendOption[]> {
    return [{ id: "codex", name: "Codex", available: this.codex.connected && this.codex.account !== null,
      models: this.codex.models, ...(!this.codex.account ? { message: "请在服务所在机器完成 codex login。" } : !this.codex.connected ? { message: "Codex 正在重连。" } : {}) }, await this.pi.describe()];
  }
  async start() { try { await this.codex.start(); } catch (error) { this.emit("warning", error); } }
  stop() { this.pi.stop(); this.codex.stop(); }
  private forSession(id: string) { return sessionBackend(id) === "pi" ? this.pi : this.codex; }
  private codexOnly(id: string, feature: string) { if (sessionBackend(id) === "pi") unsupportedPiFeature(feature); return this.codex; }
  startSession: AgentBackend["startSession"] = (cwd, settings, ephemeral, source) =>
    (settings.backend === "pi" ? this.pi : this.codex).startSession(cwd, settings, ephemeral, source);
  readSession: AgentBackend["readSession"] = (id) => this.forSession(id).readSession(id);
  resumeSession: AgentBackend["resumeSession"] = (id, settings) => this.forSession(id).resumeSession(id, settings);
  startTurn: AgentBackend["startTurn"] = (id, ...args) => this.forSession(id).startTurn(id, ...args);
  steerTurn: AgentBackend["steerTurn"] = (id, ...args) => this.forSession(id).steerTurn(id, ...args);
  interruptTurn: AgentBackend["interruptTurn"] = (id, turn) => this.forSession(id).interruptTurn(id, turn);
  readSessionCost: AgentBackend["readSessionCost"] = (id) => this.forSession(id).readSessionCost(id);
  renameSession: AgentBackend["renameSession"] = (id, name) => this.forSession(id).renameSession(id, name);
  archiveSession: AgentBackend["archiveSession"] = (id) => this.forSession(id).archiveSession(id);
  unsubscribe: AgentBackend["unsubscribe"] = (id) => this.forSession(id).unsubscribe(id);
  compactThread: AgentBackend["compactThread"] = (id) => this.forSession(id).compactThread(id);
  getGoal: AgentBackend["getGoal"] = (id) => this.forSession(id).getGoal(id);
  setGoal: AgentBackend["setGoal"] = (params) => this.codexOnly(params.threadId, "Goal").setGoal(params);
  clearGoal: AgentBackend["clearGoal"] = (id) => this.codexOnly(id, "Goal").clearGoal(id);
  startReview: AgentBackend["startReview"] = (id, target) => this.codexOnly(id, "Review").startReview(id, target);
  forkSession: AgentBackend["forkSession"] = (id, ...args) => this.codexOnly(id, "Fork").forkSession(id, ...args);
  createSideChat: AgentBackend["createSideChat"] = (id, ...args) => this.codexOnly(id, "Side Chat").createSideChat(id, ...args);
  createEmptySideChat: AgentBackend["createEmptySideChat"] = (...args) => this.codex.createEmptySideChat(...args);
  listSkills: AgentBackend["listSkills"] = (cwd) => this.codex.connected ? this.codex.listSkills(cwd) : Promise.resolve([]);
  listSubagents: CodexAdapter["listSubagents"] = (...args) => this.codex.connected ? this.codex.listSubagents(...args) : Promise.resolve({ data: [], nextCursor: null });
  listSessions: AgentBackend["listSessions"] = async (input = {}) => {
    const page = this.codex.connected ? await this.codex.listSessions(input) : { data: [], nextCursor: null };
    if (page.nextCursor) return page;
    const pi = await this.pi.listSessions(input);
    return { data: [...page.data, ...pi.data], nextCursor: null };
  };
  respondPendingRequest: AgentBackend["respondPendingRequest"] = (id, allow, answers) => {
    if (id.startsWith("pi-request:")) this.pi.respondPendingRequest(id, allow, answers);
    else this.codex.respondPendingRequest(id, allow, answers);
  };
  restartForRecovery() { return this.codex.restartForRecovery(); }
  generateSessionTitle(cwd: string, userRequest: string, outcome: string, id?: string) {
    return id && sessionBackend(id) === "pi" ? this.pi.generateSessionTitle(cwd, userRequest) : this.codex.generateSessionTitle(cwd, userRequest, outcome);
  }
}
