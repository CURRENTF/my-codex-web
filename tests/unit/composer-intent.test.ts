import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apiErrorCode, expectedSteerTurnId, isTurnFinishedConflict } from "../../apps/web/src/composer-intent";

const composerSource = readFileSync(
  fileURLToPath(new URL("../../apps/web/src/components/Composer.tsx", import.meta.url)),
  "utf8",
);

describe("Composer submission intent", () => {
  it("preserves a Steer target after the Turn finishes before click dispatch", () => {
    expect(expectedSteerTurnId("turn-active", false, undefined)).toBe("turn-active");
  });

  it("uses the live Turn when there is no remembered draft intent", () => {
    expect(expectedSteerTurnId(null, true, "turn-live")).toBe("turn-live");
    expect(expectedSteerTurnId(null, false, undefined)).toBeNull();
  });

  it("shows the Steer race recovery only for the turn_finished 409", () => {
    expect(isTurnFinishedConflict({ status: 409, body: { error: "turn_finished" } })).toBe(true);
    expect(isTurnFinishedConflict({ status: 409, body: { error: "project_unavailable" } })).toBe(false);
    expect(isTurnFinishedConflict({ status: 409, body: { error: "active_turn" } })).toBe(false);
    expect(apiErrorCode({ status: 409, body: { error: "project_unavailable" } })).toBe("project_unavailable");
  });

  it("renders an Interrupt failure instead of silently leaving the Turn running", () => {
    expect(composerSource).toContain("interrupt.error && <p className=\"composer-error\"");
  });

  it("disables submission while a Session is waiting for reconnect reconciliation", () => {
    expect(composerSource).toContain("const disconnected = runtimeState === \"disconnected\"");
    expect(composerSource).toContain("const blocked = (disabled || disconnected) && !running");
    expect(composerSource).toContain("Session 尚未完成重同步");
  });
});
