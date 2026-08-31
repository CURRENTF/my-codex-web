import { describe, expect, it, vi } from "vitest";
import { CodexAdapter, JsonRpcError, JsonRpcMutationConnectionLostError, JsonRpcMutationResponseTimeoutError, NON_IDEMPOTENT_MUTATION_TIMEOUT, normalizeGeneratedTitle, OperationUncertainError } from "@codex-web/codex-adapter";

function protocolTurn(id: string) {
  return { id, status: "completed", items: [], error: null, startedAt: 1, completedAt: 2, durationMs: 1_000 };
}

function initialization(userAgent = "Codex Desktop/0.151.0 (Linux; x86_64) dumb (codex-web; test)") {
  return { userAgent, codexHome: "/tmp/codex-web-adapter-home", platformFamily: "unix", platformOs: "linux" };
}

function protocolThread({ id = "thread-1", historyMode = "paginated", preview = "", turns = [] as ReturnType<typeof protocolTurn>[] } = {}) {
  return {
    id, sessionId: "session-1", forkedFromId: null, parentThreadId: null, preview, ephemeral: false,
    section: null, sectionEnteredAt: null, projectId: null, historyMode,
    modelProvider: "openai", createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: "idle" }, path: null,
    cwd: "/tmp/project", cliVersion: "0.151.0", source: "appServer", threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: null, turns,
  };
}

describe("Codex Adapter initialization", () => {
  it("lists Subagents separately with their parent, identity, context, and runtime state", async () => {
    const thread = (id: string, status: { type: "active"; activeFlags: string[] } | { type: "idle" } | { type: "notLoaded" }) => ({
      id, sessionId: "session-1", forkedFromId: "parent", parentThreadId: "parent", preview: "", ephemeral: false,
      modelProvider: "openai", createdAt: 2, updatedAt: 3, recencyAt: 3, status, path: null,
      cwd: "/tmp/project", cliVersion: "test", source: { subAgent: { thread_spawn: {
        parent_thread_id: "parent", depth: 1, agent_path: `/root/${id}`, agent_nickname: id, agent_role: "worker",
      } } }, threadSource: null, agentNickname: id, agentRole: "worker", gitInfo: null, name: null, turns: [],
    });
    const request = vi.fn(async (_method: string, params: { cursor?: string | null }) => params.cursor === null
      ? { data: [thread("active-child", { type: "active", activeFlags: ["waitingOnUserInput"] })], nextCursor: "page-2" }
      : { data: [thread("done-child", { type: "idle" }), thread("unloaded-child", { type: "notLoaded" })], nextCursor: null });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    const first = await adapter.listSubagents();
    const second = await adapter.listSubagents(first.nextCursor);

    expect(first.data[0]).toMatchObject({
      threadId: "active-child", parentThreadId: "parent", agentNickname: "active-child",
      contextMode: "forked", state: "waitingForInput", agentStatus: "running",
    });
    expect(second.data[0]).toMatchObject({ threadId: "done-child", state: "idle", agentStatus: "completed" });
    expect(second.data[1]).toMatchObject({ threadId: "unloaded-child", state: "idle", agentStatus: "notLoaded" });
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      cursor: null,
      sourceKinds: ["subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"],
    });
  });

  it("uses a disconnecting watchdog instead of retrying non-idempotent mutations", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: null, completedAt: null, durationMs: null, error: null } };
      if (method === "thread/fork") return { thread: { id: "child", preview: "", name: null, cwd: "/tmp", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: "parent", turns: [] } };
      return {};
    });
    const transport = { request, notify: vi.fn() };
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: typeof transport }).transportValue = transport;

    await adapter.startTurn("parent", "/tmp", "hello", { model: null, reasoning: null, serviceTier: "priority", accessMode: "fullAccess" }, "message-1");
    await adapter.forkSession("parent", "turn-0", { model: null, reasoning: null, serviceTier: "priority", accessMode: "fullAccess" }, false, "/tmp", "codex-web-fork:request-1");

    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ serviceTier: "priority" }), NON_IDEMPOTENT_MUTATION_TIMEOUT);
    expect(request).toHaveBeenCalledWith("thread/fork", expect.objectContaining({ serviceTier: "priority", threadSource: "codex-web-fork:request-1" }), NON_IDEMPOTENT_MUTATION_TIMEOUT);
  });

  it("keeps JSON-RPC timeout details behind the stable Adapter error boundary", async () => {
    const request = vi.fn(async () => { throw new JsonRpcMutationResponseTimeoutError("turn/start"); });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    const operation = adapter.startTurn("parent", "/tmp", "hello", { model: null, reasoning: null, accessMode: "fullAccess" }, "message-1");

    await expect(operation).rejects.toMatchObject({
      name: "OperationUncertainError",
      code: "operation_uncertain",
      operation: "turn/start",
    });
    await expect(operation).rejects.toBeInstanceOf(OperationUncertainError);
  });

  it("keeps App Server connection-loss details behind the stable Adapter error boundary", async () => {
    const request = vi.fn(async () => {
      throw new JsonRpcMutationConnectionLostError("turn/start", new Error("codex app-server exited"));
    });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    const operation = adapter.startTurn("parent", "/tmp", "hello", { model: null, reasoning: null, accessMode: "fullAccess" }, "message-1");

    await expect(operation).rejects.toMatchObject({
      name: "OperationUncertainError",
      code: "operation_uncertain",
      operation: "turn/start",
    });
  });

  it("drops server requests from the old App Server process on disconnect", () => {
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    adapter.supervisor.emit("serverRequest", {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "echo test" },
    });

    adapter.supervisor.emit("disconnected", { code: 1, signal: null });

    expect(() => adapter.respondPendingRequest("7", true)).toThrow("Pending request not found");
  });

  it("checks account once per backend lifetime while refreshing models after reconnects", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "initialize") return initialization();
      if (method === "account/read") return { account: null };
      if (method === "model/list") return { data: [], nextCursor: null };
      return {};
    });
    const transport = { request, notify: vi.fn() };
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: typeof transport }).transportValue = transport;
    vi.spyOn(adapter.supervisor, "markReady").mockImplementation(() => undefined);

    await adapter.initialize();
    await adapter.initialize();

    expect(request.mock.calls.filter(([method]) => method === "account/read")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "model/list")).toHaveLength(2);
    expect(request).toHaveBeenCalledWith("initialize", expect.objectContaining({ capabilities: { experimentalApi: true } }));
  });

  it("rejects an App Server below the declared minimum before loading account state", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "initialize") return initialization("Codex Desktop/0.147.0 (Linux; x86_64) dumb (codex-web; test)");
      return {};
    });
    const transport = { request, notify: vi.fn() };
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: typeof transport }).transportValue = transport;

    await expect(adapter.initialize()).rejects.toThrow("Unsupported Codex CLI 0.147.0; my-codex-web requires 0.149.0 or newer");

    expect(transport.notify).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["initialize"]);
  });

  it("hydrates paginated Thread history in chronological pages with full items", async () => {
    const metadata = protocolThread({ preview: "hello" });
    const request = vi.fn(async (method: string, params: { cursor?: string | null }) => {
      if (method === "thread/read") return { thread: metadata };
      if (method === "thread/turns/list") return params.cursor === null
        ? { data: [protocolTurn("turn-1")], nextCursor: "page-2", backwardsCursor: null }
        : { data: [protocolTurn("turn-2")], nextCursor: null, backwardsCursor: null };
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    await expect(adapter.readSession("thread-1")).resolves.toMatchObject({
      id: "thread-1",
      turns: [{ id: "turn-1" }, { id: "turn-2" }],
    });
    expect(request.mock.calls).toEqual([
      ["thread/read", { threadId: "thread-1", includeTurns: false }],
      ["thread/turns/list", { threadId: "thread-1", cursor: null, limit: 100, sortDirection: "asc", itemsView: "full" }],
      ["thread/turns/list", { threadId: "thread-1", cursor: "page-2", limit: 100, sortDirection: "asc", itemsView: "full" }],
    ]);
  });

  it("resumes paginated Threads without deprecated full-history hydration", async () => {
    const metadata = protocolThread();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read") return { thread: metadata };
      if (method === "thread/resume") return {
        thread: metadata,
        model: "gpt-test",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/tmp/project",
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "dangerFullAccess" },
        reasoningEffort: "high",
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
      };
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    await expect(adapter.resumeSession("thread-1", { accessMode: "fullAccess" })).resolves.toMatchObject({ thread: { id: "thread-1", turns: [] } });
    expect(request).toHaveBeenCalledWith("thread/resume", expect.objectContaining({ threadId: "thread-1", excludeTurns: true }));
  });

  it("keeps a just-started empty paginated Thread usable before Codex materializes its rollout", async () => {
    const metadata = protocolThread();
    const started = {
      thread: metadata,
      model: "gpt-test",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/tmp/project",
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "readOnly", networkAccess: false },
      reasoningEffort: "medium",
    };
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") return started;
      if (method === "thread/read") return { thread: metadata };
      if (method === "thread/resume") throw new JsonRpcError("no rollout found for thread id thread-1", -32_600);
      if (method === "thread/turns/list") {
        throw new JsonRpcError("thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message", -32_600);
      }
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    const session = await adapter.startSession("/tmp/project", { accessMode: "readOnly", model: null, reasoning: null });

    await expect(adapter.resumeSession(session.thread.id, { accessMode: "readOnly" })).resolves.toMatchObject({
      thread: { id: "thread-1", turns: [] },
      settings: { model: "gpt-test", reasoning: "medium", accessMode: "readOnly" },
    });
    await expect(adapter.readSession(session.thread.id)).resolves.toMatchObject({ id: "thread-1", turns: [] });
  });

  it("keeps a just-created empty paginated Thread open when its turn index is briefly unavailable", async () => {
    const metadata = protocolThread();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read") return { thread: metadata };
      if (method === "thread/turns/list") throw new JsonRpcError("list_turns is not supported yet", -32_601);
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    await expect(adapter.readSession("thread-1")).resolves.toMatchObject({ id: "thread-1", preview: "", turns: [] });
  });

  it("does not pretend a cold empty paginated Thread is loaded after materialization state is lost", async () => {
    const metadata = protocolThread();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read") return { thread: metadata };
      if (method === "thread/turns/list") throw new JsonRpcError("thread not loaded: thread-1", -32_600);
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    await expect(adapter.readSession("thread-1")).rejects.toMatchObject({ code: -32_600 });
  });

  it("does not hide turn pagination failures for a non-empty Thread", async () => {
    const metadata = protocolThread({ preview: "existing conversation" });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read") return { thread: metadata };
      if (method === "thread/turns/list") throw new JsonRpcError("list_turns is not supported yet", -32_601);
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    await expect(adapter.readSession("thread-1")).rejects.toMatchObject({ code: -32_601 });
  });

  it("loads every model/list page before projecting the model catalog", async () => {
    const model = (id: string, hidden = false) => ({
      id,
      model: id,
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: id.toUpperCase(),
      description: `${id} description`,
      hidden,
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
      defaultReasoningEffort: "high",
      inputModalities: ["text"],
      supportsPersonality: false,
      additionalSpeedTiers: [],
      serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
      defaultServiceTier: null,
      isDefault: id === "model-a",
    });
    const request = vi.fn(async (method: string, params: { cursor?: string | null }) => {
      if (method !== "model/list") return {};
      return params.cursor === null
        ? { data: [model("model-a")], nextCursor: "page-2" }
        : { data: [model("model-hidden", true), model("model-b")], nextCursor: null };
    });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    await expect(adapter.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "model-a", isDefault: true, serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }], defaultServiceTier: null }),
      expect.objectContaining({ id: "model-b", isDefault: false, serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }], defaultServiceTier: null }),
    ]);
    expect(request.mock.calls).toEqual([
      ["model/list", { cursor: null, limit: 100, includeHidden: false }],
      ["model/list", { cursor: "page-2", limit: 100, includeHidden: false }],
    ]);
  });

  it("lists enabled skills for the project cwd and sends selected skills as structured input", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "skills/list") return {
        data: [{
          cwd: "/tmp/project",
          errors: [],
          skills: [
            { name: "design-taste-frontend", description: "Frontend design workflow", path: "/skills/design/SKILL.md", scope: "user", enabled: true },
            { name: "design-taste-frontend", description: "Shadowed duplicate", path: "/repo/skills/design/SKILL.md", scope: "repo", enabled: true },
            { name: "disabled-skill", description: "Disabled", path: "/skills/disabled/SKILL.md", scope: "user", enabled: false },
          ],
        }],
      };
      if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: null, completedAt: null, durationMs: null, error: null } };
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    const skills = await adapter.listSkills("/tmp/project");
    expect(skills).toEqual([expect.objectContaining({ name: "design-taste-frontend", path: "/skills/design/SKILL.md" })]);

    await adapter.startTurn("thread-1", "/tmp/project", "redesign this", { model: null, reasoning: null, accessMode: "fullAccess" }, "message-1", skills);
    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      input: [
        { type: "skill", name: "design-taste-frontend", path: "/skills/design/SKILL.md" },
        { type: "text", text: "redesign this", text_elements: [] },
      ],
    }), NON_IDEMPOTENT_MUTATION_TIMEOUT);
  });

  it("sends uploaded images and files as structured App Server input", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: null, completedAt: null, durationMs: null, error: null } };
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    await adapter.startTurn(
      "thread-1",
      "/tmp/project",
      "inspect these",
      { model: null, reasoning: null, accessMode: "fullAccess" },
      "message-1",
      [],
      [
        { kind: "image", name: "screen.png", path: "/tmp/uploads/screen.png" },
        { kind: "file", name: "notes.txt", path: "/tmp/uploads/notes.txt" },
      ],
    );

    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      input: [
        { type: "text", text: "inspect these", text_elements: [] },
        { type: "localImage", path: "/tmp/uploads/screen.png" },
        { type: "mention", name: "notes.txt", path: "/tmp/uploads/notes.txt" },
      ],
    }), NON_IDEMPOTENT_MUTATION_TIMEOUT);
  });

  it("uses dedicated App Server methods for compact and review commands", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "review/start") return {
        reviewThreadId: "thread-1",
        turn: { id: "review-turn", status: "inProgress", items: [], startedAt: null, completedAt: null, durationMs: null, error: null },
      };
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    await adapter.compactThread("thread-1");
    await adapter.startReview("thread-1", { type: "uncommittedChanges" });

    expect(request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" }, NON_IDEMPOTENT_MUTATION_TIMEOUT);
    expect(request).toHaveBeenCalledWith("review/start", { threadId: "thread-1", target: { type: "uncommittedChanges" }, delivery: "inline" }, NON_IDEMPOTENT_MUTATION_TIMEOUT);
  });

  it("does not repeat a successful account check when model loading is retried", async () => {
    let modelAttempts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "initialize") return initialization();
      if (method === "account/read") return { account: null };
      if (method === "model/list" && modelAttempts++ === 0) throw new Error("temporary model failure");
      if (method === "model/list") return { data: [], nextCursor: null };
      return {};
    });
    const transport = { request, notify: vi.fn() };
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: typeof transport }).transportValue = transport;
    vi.spyOn(adapter.supervisor, "markReady").mockImplementation(() => undefined);

    await expect(adapter.initialize()).rejects.toThrow("temporary model failure");
    await adapter.initialize();

    expect(request.mock.calls.filter(([method]) => method === "account/read")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "model/list")).toHaveLength(2);
  });

  it("retries account/read after a transient initialization failure", async () => {
    let accountAttempts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "initialize") return initialization();
      if (method === "account/read" && accountAttempts++ === 0) throw new Error("temporary account failure");
      if (method === "account/read") return { account: null };
      if (method === "model/list") return { data: [], nextCursor: null };
      return {};
    });
    const transport = { request, notify: vi.fn() };
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: typeof transport }).transportValue = transport;
    vi.spyOn(adapter.supervisor, "markReady").mockImplementation(() => undefined);

    await expect(adapter.initialize()).rejects.toThrow("temporary account failure");
    await adapter.initialize();

    expect(request.mock.calls.filter(([method]) => method === "account/read")).toHaveLength(2);
  });

  it("isolates ephemeral title generation from normal events and server requests", async () => {
    let adapter!: CodexAdapter;
    const respondError = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        adapter.supervisor.emit("notification", {
          method: "thread/started",
          params: { thread: { id: "title-thread", threadSource: "codex-web-title-generator" } },
        });
        return { thread: { id: "title-thread" } };
      }
      if (method === "turn/start") {
        adapter.supervisor.emit("serverRequest", {
          id: 91,
          method: "item/tool/requestUserInput",
          params: { threadId: "title-thread", turnId: "title-turn", questions: [] },
        });
        queueMicrotask(() => {
          adapter.supervisor.emit("notification", {
            method: "item/completed",
            params: { threadId: "title-thread", turnId: "title-turn", item: { type: "agentMessage", id: "answer", text: "{\"title\":\"**自动标题部署。**\"}" } },
          });
          adapter.supervisor.emit("notification", {
            method: "turn/completed",
            params: { threadId: "title-thread", turn: { id: "title-turn", status: "completed", items: [] } },
          });
          adapter.supervisor.emit("notification", {
            method: "serverRequest/resolved",
            params: { requestId: 91 },
          });
        });
        return { turn: { id: "title-turn", status: "inProgress", items: [] } };
      }
      return {};
    });
    const transport = { request, notify: vi.fn(), respondError, connected: true };
    adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: typeof transport }).transportValue = transport;
    const events: unknown[] = [];
    const pendingRequests: unknown[] = [];
    adapter.on("event", (event) => events.push(event));
    adapter.on("pendingRequest", (requestValue) => pendingRequests.push(requestValue));

    await expect(adapter.generateSessionTitle("/tmp/project", "添加标题", "功能已实现")).resolves.toBe("自动标题部署");

    expect(events).toEqual([]);
    expect(pendingRequests).toEqual([]);
    expect(respondError).toHaveBeenCalledWith(91, -32_601, expect.stringContaining("title generation"));
    expect(request).toHaveBeenCalledWith("thread/start", expect.objectContaining({
      ephemeral: true,
      threadSource: "codex-web-title-generator",
      approvalPolicy: "never",
      sandbox: "read-only",
    }), 30_000);
    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId: "title-thread",
      effort: "low",
      outputSchema: expect.objectContaining({ required: ["title"] }),
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    }), 30_000);
    expect(request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "title-thread" }, 30_000);
  });

  it("normalizes structured, Markdown, and overlong generated titles", () => {
    expect(normalizeGeneratedTitle("```json\n{\"title\":\"**修复自动标题。**\"}\n```")).toBe("修复自动标题");
    expect(normalizeGeneratedTitle("\"Deploy session title!\"")).toBe("Deploy session title");
    expect(Array.from(normalizeGeneratedTitle("长".repeat(80)) ?? "")).toHaveLength(48);
    expect(normalizeGeneratedTitle("。！？")).toBeNull();
  });

  it("cancels an in-flight ephemeral title Turn on App Server disconnect", async () => {
    let connected = true;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "title-thread" } };
      if (method === "turn/start") return { turn: { id: "title-turn", status: "inProgress", items: [] } };
      return {};
    });
    const transport = { request, notify: vi.fn(), respondError: vi.fn(), get connected() { return connected; } };
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: typeof transport }).transportValue = transport;

    const generation = adapter.generateSessionTitle("/tmp/project", "生成标题", "任务完成");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("turn/start", expect.anything(), 30_000));
    connected = false;
    adapter.supervisor.emit("disconnected", { code: 1, signal: null });

    await expect(generation).rejects.toThrow("disconnected during title generation");
    expect(request).not.toHaveBeenCalledWith("thread/unsubscribe", expect.anything(), expect.anything());
  });
});
