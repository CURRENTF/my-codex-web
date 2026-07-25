import { describe, expect, it } from "vitest";
import { JsonRpcError } from "../../packages/codex-adapter/src/json-rpc-transport";
import { safeErrorForLog } from "../../apps/server/src/safe-error";

describe("safe error logging", () => {
  it("keeps only a safe name and scalar code from JSON-RPC failures", () => {
    const error = new JsonRpcError("prompt and command output", -32_600, {
      prompt: "secret prompt",
      output: "complete command output",
      fileContents: "private file contents",
    });

    expect(safeErrorForLog(error)).toEqual({ name: "JsonRpcError", code: -32_600 });
    expect(JSON.stringify(safeErrorForLog(error))).not.toContain("secret");
    expect(JSON.stringify(safeErrorForLog(error))).not.toContain("command output");
    expect(JSON.stringify(safeErrorForLog(error))).not.toContain("file contents");
  });

  it("does not serialize arbitrary non-Error values", () => {
    expect(safeErrorForLog({ prompt: "secret prompt" })).toEqual({ name: "NonError" });
  });
});
