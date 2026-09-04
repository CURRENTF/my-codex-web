import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apiErrorCode, expectedSteerTurnId, isTurnFinishedConflict } from "../../apps/web/src/composer-intent";

const composerSource = readFileSync(
  fileURLToPath(new URL("../../apps/web/src/components/Composer.tsx", import.meta.url)),
  "utf8",
);
const sessionPaneSource = readFileSync(
  fileURLToPath(new URL("../../apps/web/src/components/SessionPane.tsx", import.meta.url)),
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
    expect(composerSource).toMatch(/const queueCommand[\s\S]*steerDraftTurnId\.current = null;[\s\S]*enqueueSubmission/);
  });

  it("offers an explicit Steer or queue choice while a Turn is running", () => {
    expect(composerSource).toContain('role="switch" aria-checked={deliveryMode === "queue"}');
    expect(composerSource).toContain('className={`delivery-mode-toggle ${deliveryMode}`}');
    expect(composerSource).toMatch(/reasoning-select[\s\S]*delivery-mode-toggle[\s\S]*stop-button[\s\S]*send-button/);
    expect(composerSource).toContain('running && deliveryMode === "queue"');
  });

  it("queues a normal requirement with its Skill and Turn settings", () => {
    expect(composerSource).toMatch(/const queueMessage[\s\S]*skillNames: referencedSkillNames[\s\S]*model,[\s\S]*reasoning,[\s\S]*accessMode,[\s\S]*enqueueSubmission/);
    expect(composerSource).toContain("sendQueuedMessage.mutate(queuedSubmission)");
  });

  it("renders and drains every queued command and requirement in FIFO order", () => {
    expect(composerSource).toContain("const queuedSubmission = queuedSubmissions[0]");
    expect(composerSource).toContain("queuedSubmissions.map((submission, index)");
    expect(composerSource).toContain("runQueuedSubmission");
    expect(composerSource).not.toContain("当前 Session 已有一项排队内容");
  });

  it("propagates queued configuration commands to later requirements", () => {
    expect(composerSource).toContain("if (result.queuedSettings) applyQueuedSettings(threadId, result.queuedSettings)");
    expect(composerSource).toMatch(/command === "model"[\s\S]*return \{ queuedSettings \}/);
    expect(composerSource).toMatch(/command === "reasoning"[\s\S]*const queuedSettings = \{ \.\.\.effectiveSettings\.current, reasoning: args \}/);
    expect(composerSource).toMatch(/command === "permissions"[\s\S]*const queuedSettings = \{ \.\.\.effectiveSettings\.current, accessMode: next \}/);
  });

  it("waits for Fork and Side Chat completion before advancing the queue", () => {
    expect(composerSource).toContain("if (!await onForkLatest(clientRequestId))");
    expect(composerSource).toContain("if (!await onOpenSideChat(clientRequestId))");
    expect(composerSource).toContain("isQueuedTimelineSettled(null, { latestTurnId, latestTurnStatus })");
    expect(sessionPaneSource).toContain("fork.mutateAsync");
    expect(sessionPaneSource).toContain("side.mutateAsync");
  });

  it("reuses the queued request ID for idempotent Fork and Side Chat retries", () => {
    expect(sessionPaneSource).toContain("clientRequestId = newClientRequestId()");
    expect(sessionPaneSource).toContain("JSON.stringify({ lastTurnId: turnId, empty, prefill, inheritGoal: shouldInheritGoal, clientRequestId })");
    expect(sessionPaneSource).toContain("JSON.stringify({ anchorTurnId, clientRequestId })");
    expect(sessionPaneSource).toContain('disabled={fork.isPending}>取消</button>');
  });

  it("remounts Session-local action state when navigation changes the thread", () => {
    const appSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/App.tsx", import.meta.url)), "utf8");
    expect(appSource).toContain("<SessionPane key={selectedThreadId}");
    expect(sessionPaneSource).toContain("pendingForkRef.current?.settle(false)");
    expect(sessionPaneSource).toContain("parentThreadId: threadId");
    expect(sessionPaneSource).toContain("if (!mountedForThread.current) return");
    expect(sessionPaneSource).toContain("removeQueuedSubmission(request.parentThreadId, request.clientRequestId)");
  });

  it("restores the effective configuration while the parent queue remains", () => {
    expect(composerSource).toContain("state.queuedEffectiveSettings[threadId]");
    expect(composerSource).toContain("queuedEffectiveSettings?.model ?? initialSettings.model");
  });

  it("persists the accepted queued Turn barrier across Session navigation", () => {
    expect(composerSource).toContain("state.queuedTurnBarriers[threadId] ?? null");
    expect(composerSource).toContain("setStoredQueuedTurnBarrier(threadId");
  });

  it("states that a fork does not inherit the parent's queued content", () => {
    expect(sessionPaneSource).toContain("父 Session 的排队内容不会带入");
  });

  it("prefers high reasoning for models that support it", () => {
    expect(composerSource).toMatch(/function preferredReasoningForModel[\s\S]*item\.effort === "high"[\s\S]*model\?\.defaultReasoning/);
    expect(composerSource).toContain("const nextReasoning = preferredReasoningForModel(option)");
    expect(composerSource).toContain("setReasoning(nextReasoning)");
  });

  it("applies Goal commands immediately while a Turn is running", () => {
    expect(composerSource).toContain('if (running && parsed.name !== "goal") { queueCommand(draft); return; }');
  });
});
