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

  it("recognizes only the turn_finished 409 for automatic next-Turn fallback", () => {
    expect(isTurnFinishedConflict({ status: 409, body: { error: "turn_finished" } })).toBe(true);
    expect(isTurnFinishedConflict({ status: 409, body: { error: "project_unavailable" } })).toBe(false);
    expect(isTurnFinishedConflict({ status: 409, body: { error: "active_turn" } })).toBe(false);
    expect(apiErrorCode({ status: 409, body: { error: "project_unavailable" } })).toBe("project_unavailable");
    expect(composerSource).toMatch(/if \(!isTurnFinishedConflict\(error\)\) throw error;[\s\S]*clientUserMessageId/);
    expect(composerSource).not.toContain("当前执行刚刚结束");
    expect(composerSource).not.toContain("forceTurn");
  });

  it("does not start a stale Session-detail refetch immediately after an accepted submission", () => {
    const successBlocks = [...composerSource.matchAll(/onSuccess:\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\},\s*onError/g)].map((match) => match[0]);
    const submissionBlocks = successBlocks.filter((block) => block.includes("acceptSubmission(threadId)"));
    expect(submissionBlocks).toHaveLength(2);
    expect(submissionBlocks.every((block) => !block.includes('queryKey: ["session", threadId]'))).toBe(true);
    expect(submissionBlocks.every((block) => block.includes('queryKey: ["sessions"]'))).toBe(true);
  });

  it("renders an Interrupt failure instead of silently leaving the Turn running", () => {
    expect(composerSource).toContain("interrupt.error && <p className=\"composer-error\"");
  });

  it("disables submission while a Session is waiting for reconnect reconciliation", () => {
    expect(composerSource).toContain("const disconnected = runtimeState === \"disconnected\"");
    expect(composerSource).toContain("const blocked = (disabled || disconnected) && !running");
    expect(composerSource).toContain("Session 尚未完成重同步");
  });

  it("clears remembered Steer intent when a Slash command is queued for the next Turn", () => {
    expect(composerSource).toMatch(/const queueCommand[\s\S]*steerDraftTurnId\.current = null;[\s\S]*queueSlashCommand/);
  });

  it("offers an explicit Steer or queue choice while a Turn is running", () => {
    expect(composerSource).toContain('role="switch" aria-checked={deliveryMode === "queue"}');
    expect(composerSource).toContain('className={`delivery-mode-toggle ${deliveryMode}`}');
    expect(composerSource).toMatch(/reasoning-select[\s\S]*delivery-mode-toggle[\s\S]*stop-button[\s\S]*send-button/);
    expect(composerSource).toContain('running && deliveryMode === "queue"');
  });

  it("queues a normal requirement with its Skill and Turn settings", () => {
    expect(composerSource).toMatch(/const queueMessage[\s\S]*skillNames: referencedSkillNames[\s\S]*model,[\s\S]*reasoning,[\s\S]*accessMode,[\s\S]*queueUserMessage/);
    expect(composerSource).toContain("sendQueuedMessage.mutate(queuedUserMessage)");
  });

  it("prefers high reasoning for models that support it", () => {
    expect(composerSource).toMatch(/function preferredReasoningForModel[\s\S]*item\.effort === "high"[\s\S]*model\?\.defaultReasoning/);
    expect(composerSource).toContain("setReasoning(preferredReasoningForModel(option))");
  });

  it("applies Goal commands immediately while a Turn is running", () => {
    expect(composerSource).toContain('if (running && parsed.name !== "goal") { queueCommand(draft); return; }');
  });
});
