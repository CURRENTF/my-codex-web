import { describe, expect, it, vi } from "vitest";
import { CodexAdapter, JsonRpcMutationConnectionLostError, JsonRpcMutationResponseTimeoutError, NON_IDEMPOTENT_MUTATION_TIMEOUT, OperationUncertainError } from "@codex-web/codex-adapter";

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
});
