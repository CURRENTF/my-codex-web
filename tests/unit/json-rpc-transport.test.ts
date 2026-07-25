import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { isRetryableRequestError, JsonRpcError, JsonRpcMutationResponseTimeoutError, JsonRpcTransport, retryDelayMs } from "../../packages/codex-adapter/src/json-rpc-transport.js";

describe("JSON-RPC retry policy", () => {
  it("retries transient failures only for idempotent read methods", () => {
    expect(isRetryableRequestError("thread/read", new JsonRpcError("busy", -32_000))).toBe(true);
    expect(isRetryableRequestError("thread/list", new JsonRpcError("internal", -32_603))).toBe(true);
    expect(isRetryableRequestError("model/list", new Error("JSON-RPC timeout for model/list"))).toBe(true);
    expect(isRetryableRequestError("turn/start", new JsonRpcError("busy", -32_000))).toBe(false);
    expect(isRetryableRequestError("thread/read", new JsonRpcError("invalid", -32_602))).toBe(false);
  });

  it("uses bounded exponential delay with jitter", () => {
    expect(retryDelayMs(0, 0)).toBe(80);
    expect(retryDelayMs(1, 1)).toBe(240);
    expect(retryDelayMs(10, 1)).toBe(1_580);
  });

  it("rejects valid JSON primitives and arrays without throwing in the line handler", () => {
    const transport = new JsonRpcTransport({ cwd: "/tmp", codexHome: "/tmp/codex-web-json-rpc-test" });
    const protocolErrors: Error[] = [];
    transport.on("protocolError", (error: Error) => protocolErrors.push(error));
    const handleLine = (transport as unknown as { handleLine(line: string): void }).handleLine.bind(transport);

    expect(() => handleLine("null")).not.toThrow();
    expect(() => handleLine("42")).not.toThrow();
    expect(() => handleLine("[]")).not.toThrow();
    expect(protocolErrors).toHaveLength(3);
  });

  it("disconnects a stalled non-idempotent mutation so its lock can be released without retrying", async () => {
    vi.useFakeTimers();
    try {
      const transport = new JsonRpcTransport({ cwd: "/tmp", codexHome: "/tmp/codex-web-json-rpc-test" });
      const write = vi.fn();
      const kill = vi.fn();
      const disconnecting = vi.fn();
      const child = Object.assign(new EventEmitter(), {
        stdin: { write }, killed: false, exitCode: null, signalCode: null, kill,
      });
      Object.assign(transport, { child, closed: false });
      transport.on("disconnecting", disconnecting);

      const request = transport.request<{ ok: boolean }>("thread/fork", { threadId: "parent" }, {
        timeoutMs: 1_000,
        disconnectOnTimeout: true,
      });
      const rejected = expect(request).rejects.toBeInstanceOf(JsonRpcMutationResponseTimeoutError);
      await vi.advanceTimersByTimeAsync(1_000);

      await rejected;
      expect(write).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(transport.connected).toBe(false);
      expect(disconnecting).toHaveBeenCalledTimes(1);
      (transport as unknown as { handleLine(line: string): void }).handleLine('{"id":1,"result":{"ok":true}}');
      expect(write).toHaveBeenCalledTimes(1);
      child.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks an in-flight non-idempotent mutation uncertain when the App Server exits", async () => {
    const transport = new JsonRpcTransport({ cwd: "/tmp", codexHome: "/tmp/codex-web-json-rpc-test" });
    const write = vi.fn();
    Object.assign(transport, { child: { stdin: { write } }, closed: false });

    const request = transport.request("turn/start", { threadId: "thread-1" }, {
      timeoutMs: 60_000,
      disconnectOnTimeout: true,
      operationUncertainOnDisconnect: true,
    });
    (transport as unknown as { closeWithError(error: Error): void }).closeWithError(new Error("codex app-server exited"));

    await expect(request).rejects.toMatchObject({
      name: "JsonRpcMutationConnectionLostError",
      code: "operation_uncertain",
      method: "turn/start",
    });
  });

  it("disconnects the transport when writing a request to App Server fails synchronously", async () => {
    const transport = new JsonRpcTransport({ cwd: "/tmp", codexHome: "/tmp/codex-web-json-rpc-test" });
    const kill = vi.fn();
    const child = Object.assign(new EventEmitter(), {
      stdin: { write: vi.fn(() => { throw new Error("broken pipe"); }) },
      killed: false,
      exitCode: null,
      signalCode: null,
      kill,
    });
    Object.assign(transport, { child, closed: false });

    const request = transport.request("turn/start", { threadId: "thread-1" }, {
      timeoutMs: 60_000,
      disconnectOnTimeout: true,
      operationUncertainOnDisconnect: true,
    });

    await expect(request).rejects.toMatchObject({
      name: "JsonRpcMutationConnectionLostError",
      method: "turn/start",
    });
    expect(transport.connected).toBe(false);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close");
  });

  it("disconnects and preserves mutation uncertainty when stdin emits an asynchronous error", async () => {
    const transport = new JsonRpcTransport({ cwd: "/tmp", codexHome: "/tmp/codex-web-json-rpc-test" });
    const kill = vi.fn();
    const stdin = Object.assign(new EventEmitter(), { write: vi.fn() });
    const child = Object.assign(new EventEmitter(), {
      stdin,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill,
    });
    Object.assign(transport, { child, closed: false });
    (transport as unknown as { watchStdinErrors(childProcess: typeof child): void }).watchStdinErrors(child);

    const request = transport.request("turn/start", { threadId: "thread-1" }, {
      timeoutMs: 60_000,
      disconnectOnTimeout: true,
      operationUncertainOnDisconnect: true,
    });
    stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    await expect(request).rejects.toMatchObject({
      name: "JsonRpcMutationConnectionLostError",
      code: "operation_uncertain",
      method: "turn/start",
    });
    expect(transport.connected).toBe(false);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close");
  });

  it("force-kills an App Server that does not exit after stop", async () => {
    vi.useFakeTimers();
    try {
      const transport = new JsonRpcTransport({ cwd: "/tmp", codexHome: "/tmp/codex-web-json-rpc-test" });
      const kill = vi.fn();
      const child = Object.assign(new EventEmitter(), {
        stdin: { write: vi.fn() }, killed: false, exitCode: null, signalCode: null, kill,
      });
      Object.assign(transport, { child, closed: false });

      transport.stop();
      expect(kill).toHaveBeenCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(2_000);
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds acknowledged mutations without disconnecting the App Server", async () => {
    vi.useFakeTimers();
    try {
      const transport = new JsonRpcTransport({ cwd: "/tmp", codexHome: "/tmp/codex-web-json-rpc-test" });
      const write = vi.fn();
      Object.assign(transport, { child: { stdin: { write } }, closed: false });

      const request = transport.request("thread/inject_items", { threadId: "side-1" }, 1_000);
      const rejected = expect(request).rejects.toThrow("JSON-RPC timeout for thread/inject_items");
      await vi.advanceTimersByTimeAsync(1_000);

      await rejected;
      expect(transport.connected).toBe(true);
      (transport as unknown as { handleLine(line: string): void }).handleLine('{"id":1,"result":{}}');
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
