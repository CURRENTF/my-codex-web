import { describe, expect, it } from "vitest";
import { isRetryableRequestError, JsonRpcError, retryDelayMs } from "../../packages/codex-adapter/src/json-rpc-transport.js";

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
});
