import { describe, expect, it } from "vitest";
import type { ModelOption } from "@codex-web/shared-types";
import { fastServiceTierForModel, serviceTierForModel } from "../../apps/web/src/service-tier";

const fast = { id: "priority", name: "Fast", description: "1.5x speed, increased usage" };
const model: ModelOption = {
  id: "gpt-test",
  model: "gpt-test",
  displayName: "GPT Test",
  description: "Test model",
  isDefault: true,
  defaultReasoning: "high",
  supportedReasoning: [{ effort: "high" }],
  serviceTiers: [fast],
  defaultServiceTier: "priority",
  inputModalities: ["text"],
};

describe("service-tier selection", () => {
  it("uses catalog IDs instead of assuming the Fast display name is the protocol value", () => {
    expect(fastServiceTierForModel(model)).toEqual(fast);
    expect(serviceTierForModel(model, "priority")).toBe("priority");
    expect(serviceTierForModel(model, undefined)).toBe("priority");
  });

  it("preserves an explicit Standard selection and drops tiers unsupported by the selected model", () => {
    expect(serviceTierForModel(model, null)).toBeNull();
    expect(serviceTierForModel({ ...model, serviceTiers: [], defaultServiceTier: null }, "priority")).toBeNull();
    expect(fastServiceTierForModel({ ...model, serviceTiers: [], defaultServiceTier: null })).toBeUndefined();
  });
});
