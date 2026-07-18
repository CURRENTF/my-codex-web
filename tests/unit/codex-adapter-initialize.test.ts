import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "@codex-web/codex-adapter";

describe("Codex Adapter initialization", () => {
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
