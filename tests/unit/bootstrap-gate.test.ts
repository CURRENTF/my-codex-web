import { describe, expect, it } from "vitest";
import { bootstrapGate } from "../../apps/web/src/bootstrap-gate";

describe("bootstrap gate", () => {
  it("shows disconnection before interpreting missing account state as logged out", () => {
    expect(bootstrapGate("disconnected", false)).toBe("disconnected");
    expect(bootstrapGate("connecting", false)).toBe("disconnected");
    expect(bootstrapGate("connected", false)).toBe("authRequired");
    expect(bootstrapGate("connected", true)).toBe("ready");
  });
});
