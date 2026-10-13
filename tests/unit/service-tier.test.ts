import { describe, expect, it } from "vitest";
import type { ModelOption } from "@codex-web/shared-types";
import { projectAdapterEvent } from "@codex-web/codex-adapter";
import type { SessionPayload } from "../../apps/web/src/api";
import { applySessionEvent } from "../../apps/web/src/live-session";
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

  it("keeps Fast off when App Server reports Standard after sending with a null tier", () => {
    const session: SessionPayload = {
      thread: { id: "thread-1", preview: "", name: null, cwd: "/tmp", createdAt: 1, updatedAt: 1, ephemeral: true, forkedFromId: null, turns: [] },
      goal: null,
      runtime: { threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] },
      settings: { model: model.model, reasoning: "high", serviceTier: "priority", accessMode: "fullAccess" },
    };
    // turn/start with serviceTier: null clears Fast. App Server 0.159.2
    // then emits the canonical Standard ID, which is absent from serviceTiers.
    const update = projectAdapterEvent({ method: "thread/settings/updated", params: {
      threadId: session.thread.id,
      threadSettings: { model: model.model, effort: "high", serviceTier: "default", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    } });
    if (update?.type !== "settingsUpdated") throw new Error("Missing settings update");
    const refreshed = applySessionEvent(session, {
      seq: 1, type: "session.settings.updated", threadId: session.thread.id, emittedAt: 1, payload: { settings: update.settings },
    })!;
    expect(serviceTierForModel(model, refreshed.settings.serviceTier)).toBeNull();
    // The same Standard setting must survive history reloads and model changes.
    expect(serviceTierForModel({ ...model }, refreshed.settings.serviceTier)).toBeNull();
    expect(serviceTierForModel({ ...model, serviceTiers: [{ id: "default", name: "Standard", description: "" }, fast] }, "default")).toBeNull();
  });
});
