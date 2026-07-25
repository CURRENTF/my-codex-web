import { describe, expect, it, vi } from "vitest";
import { CodexAdapter, JsonRpcMutationConnectionLostError, JsonRpcMutationResponseTimeoutError, NON_IDEMPOTENT_MUTATION_TIMEOUT, OperationUncertainError } from "@codex-web/codex-adapter";

describe("Codex Adapter initialization", () => {
  it("uses a disconnecting watchdog instead of retrying non-idempotent mutations", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: null, completedAt: null, durationMs: null, error: null } };
      if (method === "thread/fork") return { thread: { id: "child", preview: "", name: null, cwd: "/tmp", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: "parent", turns: [] } };
      return {};
    });
    const transport = { request, notify: vi.fn() };
    const adapter = new CodexAdapter({ cwd: "/tmp", codexHome: "/tmp/codex-web-adapter-home", version: "test" });
    (adapter.supervisor as unknown as { transportValue: typeof transport }).transportValue = transport;

    await adapter.startTurn("parent", "/tmp", "hello", { model: null, reasoning: null, accessMode: "fullAccess" }, "message-1");
    await adapter.forkSession("parent", "turn-0", { model: null, reasoning: null, accessMode: "fullAccess" }, false, "/tmp", "codex-web-fork:request-1");

    expect(request).toHaveBeenCalledWith("turn/start", expect.any(Object), NON_IDEMPOTENT_MUTATION_TIMEOUT);
    expect(request).toHaveBeenCalledWith("thread/fork", expect.objectContaining({ threadSource: "codex-web-fork:request-1" }), NON_IDEMPOTENT_MUTATION_TIMEOUT);
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
      serviceTiers: [],
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
      expect.objectContaining({ id: "model-a", isDefault: true }),
      expect.objectContaining({ id: "model-b", isDefault: false }),
    ]);
    expect(request.mock.calls).toEqual([
      ["model/list", { cursor: null, limit: 100, includeHidden: false }],
      ["model/list", { cursor: "page-2", limit: 100, includeHidden: false }],
    ]);
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
