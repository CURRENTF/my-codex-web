import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../../packages/codex-adapter/src/codex-adapter.js";
import { JsonRpcError } from "../../packages/codex-adapter/src/json-rpc-transport.js";

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
