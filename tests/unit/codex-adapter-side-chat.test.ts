import { describe, expect, it, vi } from "vitest";
import { acknowledgedMutationTimeout, CodexAdapter, isThreadMaterializationRace, NON_IDEMPOTENT_MUTATION_TIMEOUT, OperationUncertainError, retryThreadMaterialization, SIDE_CHAT_BOUNDARY_TIMEOUT_MS, SIDE_CHAT_CLEANUP_RETRY_BASE_MS } from "../../packages/codex-adapter/src/codex-adapter.js";
import { JsonRpcError, JsonRpcMutationResponseTimeoutError } from "../../packages/codex-adapter/src/json-rpc-transport.js";

const emptyThread = {
  id: "side-1",
  preview: "",
  name: null,
  cwd: "/tmp/project",
  createdAt: 1,
  updatedAt: 1,
  status: { type: "idle" },
  ephemeral: true,
  modelProvider: "openai",
  model: "test-model",
  forkedFromId: null,
  permissionProfile: null,
  path: null,
  source: "appServer",
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  turns: [],
} as const;

describe("Side Chat adapter initialization", () => {
  it("does not restart recovery while a non-idempotent mutation is awaiting its response", async () => {
    let resolveStart!: (value: unknown) => void;
    const startPending = new Promise((resolve) => { resolveStart = resolve; });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") return startPending;
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp/project", codexHome: "/tmp/codex-web-test", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };
    const restart = vi.spyOn(adapter.supervisor, "retryCurrent").mockImplementation(() => undefined);

    const creating = adapter.startSession("/tmp/project", { accessMode: "fullAccess", model: null, reasoning: null });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("thread/start", expect.anything(), expect.anything()));

    expect(adapter.restartForRecovery()).toBe(false);
    expect(restart).not.toHaveBeenCalled();

    resolveStart({ thread: emptyThread });
    await creating;

    expect(adapter.restartForRecovery()).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not restart recovery while acknowledged mutations are awaiting their responses", async () => {
    let resolveMutations!: (value: unknown) => void;
    const mutationsPending = new Promise((resolve) => { resolveMutations = resolve; });
    const request = vi.fn(async () => mutationsPending);
    const adapter = new CodexAdapter({ cwd: "/tmp/project", codexHome: "/tmp/codex-web-test", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };
    const restart = vi.spyOn(adapter.supervisor, "retryCurrent").mockImplementation(() => undefined);

    const mutations = [
      adapter.interruptTurn("thread-1", "turn-1"),
      adapter.unsubscribe("thread-1"),
      adapter.renameSession("thread-1", "Renamed"),
      adapter.archiveSession("thread-1"),
      adapter.setGoal({ threadId: "thread-1", objective: "Ship V1" }),
      adapter.clearGoal("thread-1"),
    ];
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(mutations.length));

    expect(adapter.restartForRecovery()).toBe(false);
    expect(restart).not.toHaveBeenCalled();

    resolveMutations({ goal: { threadId: "thread-1", objective: "Ship V1" } });
    await Promise.all(mutations);

    expect(adapter.restartForRecovery()).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not restart recovery while a Side Chat boundary injection is awaiting acknowledgement", async () => {
    let resolveBoundary!: (value: unknown) => void;
    const boundaryPending = new Promise((resolve) => { resolveBoundary = resolve; });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: emptyThread };
      if (method === "thread/inject_items") return boundaryPending;
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp/project", codexHome: "/tmp/codex-web-test", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };
    const restart = vi.spyOn(adapter.supervisor, "retryCurrent").mockImplementation(() => undefined);

    const creating = adapter.createEmptySideChat("/tmp/project", { accessMode: "fullAccess", model: null, reasoning: null });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("thread/inject_items", expect.anything(), acknowledgedMutationTimeout(SIDE_CHAT_BOUNDARY_TIMEOUT_MS)));

    expect(adapter.restartForRecovery()).toBe(false);
    expect(restart).not.toHaveBeenCalled();

    resolveBoundary({});
    await creating;

    expect(adapter.restartForRecovery()).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("retries only explicit parent Thread materialization races before Fork", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new JsonRpcError("no rollout found for thread id redacted", -32600))
      .mockRejectedValueOnce(new JsonRpcError("thread redacted is not materialized yet", -32600))
      .mockResolvedValue("forked");
    const wait = vi.fn(async () => undefined);

    await expect(retryThreadMaterialization(operation, wait)).resolves.toBe("forked");

    expect(wait.mock.calls).toEqual([[50], [100]]);
    expect(isThreadMaterializationRace(new JsonRpcError("rollout at redacted is empty", -32600))).toBe(true);
    expect(isThreadMaterializationRace(new JsonRpcError("internal failure", -32603))).toBe(false);
  });

  it("injects the hidden boundary and clears Goal for an empty ephemeral Side Chat", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: emptyThread };
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp/project", codexHome: "/tmp/codex-web-test", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    await adapter.createEmptySideChat("/tmp/project", { accessMode: "fullAccess", model: null, reasoning: null });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/inject_items",
      "thread/goal/clear",
    ]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ threadId: "side-1" });
    expect(request.mock.calls[1]?.[2]).toEqual(acknowledgedMutationTimeout(SIDE_CHAT_BOUNDARY_TIMEOUT_MS));
  });

  it("requests metadata-only history when forking a paginated Side Chat", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/fork") return { thread: { ...emptyThread, forkedFromId: "parent" } };
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp/project", codexHome: "/tmp/codex-web-test", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    await adapter.createSideChat("parent", "turn-1", { accessMode: "fullAccess", model: null, reasoning: null }, "/tmp/project");

    expect(request).toHaveBeenCalledWith("thread/fork", expect.objectContaining({
      threadId: "parent",
      lastTurnId: "turn-1",
      ephemeral: true,
      excludeTurns: true,
      threadSource: "codex-web-side-chat",
    }), NON_IDEMPOTENT_MUTATION_TIMEOUT);
  });

  it("disconnects and reports uncertainty instead of allowing acknowledged mutations to apply late", async () => {
    const request = vi.fn(async (method: string) => {
      throw new JsonRpcMutationResponseTimeoutError(method);
    });
    const adapter = new CodexAdapter({ cwd: "/tmp/project", codexHome: "/tmp/codex-web-test", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    await expect(adapter.archiveSession("thread-1")).rejects.toBeInstanceOf(OperationUncertainError);

    expect(request).toHaveBeenCalledWith(
      "thread/archive",
      { threadId: "thread-1" },
      acknowledgedMutationTimeout(),
    );
  });

  it("rejects and unsubscribes when the hidden boundary cannot be acknowledged", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: emptyThread };
      if (method === "thread/inject_items") throw new Error("JSON-RPC timeout for thread/inject_items");
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp/project", codexHome: "/tmp/codex-web-test", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };
    await expect(adapter.createEmptySideChat("/tmp/project", { accessMode: "fullAccess", model: null, reasoning: null })).rejects.toThrow("thread/inject_items");

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/inject_items", "thread/unsubscribe"]);
  });

  it("retries failed Side Chat cleanup without restarting the App Server", async () => {
    vi.useFakeTimers();
    let unsubscribeAttempts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: emptyThread };
      if (method === "thread/inject_items") throw new Error("JSON-RPC timeout for thread/inject_items");
      if (method === "thread/unsubscribe" && unsubscribeAttempts++ === 0) throw new Error("JSON-RPC timeout for thread/unsubscribe");
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp/project", codexHome: "/tmp/codex-web-test", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };
    const restart = vi.spyOn(adapter.supervisor, "retryCurrent").mockImplementation(() => undefined);
    const warning = vi.fn();
    adapter.on("warning", warning);

    await expect(adapter.createEmptySideChat("/tmp/project", { accessMode: "fullAccess", model: null, reasoning: null })).rejects.toThrow("thread/inject_items");

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/inject_items", "thread/unsubscribe"]);
    expect(restart).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ message: "Failed to confirm cleanup for an uninitialized Side Chat" }));
    await vi.advanceTimersByTimeAsync(SIDE_CHAT_CLEANUP_RETRY_BASE_MS);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/inject_items", "thread/unsubscribe", "thread/unsubscribe"]);
    expect(restart).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("accepts the current App Server guarantee that ephemeral Threads cannot carry Goals", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: emptyThread };
      if (method === "thread/goal/clear") throw new JsonRpcError("ephemeral thread does not support goals: redacted");
      return {};
    });
    const adapter = new CodexAdapter({ cwd: "/tmp/project", codexHome: "/tmp/codex-web-test", version: "test" });
    (adapter.supervisor as unknown as { transportValue: { request: typeof request } }).transportValue = { request };

    await expect(adapter.createEmptySideChat("/tmp/project", { accessMode: "fullAccess", model: null, reasoning: null })).resolves.toMatchObject({ thread: { id: "side-1" } });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/inject_items", "thread/goal/clear"]);
  });
});
