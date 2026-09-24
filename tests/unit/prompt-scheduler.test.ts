import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../apps/server/src/database";
import { PromptScheduler } from "../../apps/server/src/prompt-scheduler";
import { ActiveTurnConflictError, type SessionService } from "../../apps/server/src/session-service";
import type { SessionTurn } from "@codex-web/shared-types";

describe("server prompt scheduler", () => {
  let root: string;
  let repositories: Repositories;
  let scheduler: PromptScheduler;
  const startTurn = vi.fn<SessionService["startTurn"]>();
  const readSession = vi.fn<SessionService["readSession"]>();
  let connected = true;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(1000000);
    root = mkdtempSync(path.join(tmpdir(), "prompt-schedule-"));
    repositories = new Repositories(path.join(root, "app.db"));
    repositories.insertProject({ id: "p", name: "Repo", rootPath: root, canonicalPath: root, orderIndex: 0, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess", createdAt: 1, lastOpenedAt: null, available: true });
    repositories.upsertProjectSession({ thread_id: "t", project_id: "p", cwd_snapshot: root, source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null, added_at: 1, last_seen_at: 1 });
    startTurn.mockReset(); startTurn.mockResolvedValue({} as Awaited<ReturnType<SessionService["startTurn"]>>);
    connected = true;
    readSession.mockReset();
    scheduler = new PromptScheduler(repositories, { startTurn, readSession }, () => connected);
  });
  afterEach(async () => { await scheduler.stop(); repositories.close(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
  const enable = () => scheduler.set("t", { intervalMinutes: 2, prompt: "检查进展", enabled: true });

  it("sends from the server timer without any browser and respects minute units", async () => {
    enable(); scheduler.start();
    await vi.advanceTimersByTimeAsync(119000); expect(startTurn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); expect(startTurn).toHaveBeenCalledTimes(1);
    expect(startTurn).toHaveBeenCalledWith("t", "检查进展", { clientUserMessageId: expect.any(String) }, expect.any(String), true);
    await vi.advanceTimersByTimeAsync(120000); expect(startTurn).toHaveBeenCalledTimes(2);
  });
  it("restores persisted schedules after restart and coalesces overdue ticks", async () => {
    enable(); await scheduler.stop(); repositories.close();
    repositories = new Repositories(path.join(root, "app.db"));
    scheduler = new PromptScheduler(repositories, { startTurn, readSession }, () => connected);
    vi.advanceTimersByTime(900000); scheduler.tick(); await scheduler.stop();
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(scheduler.get("t")?.nextRunAt).toBe(Date.now() + 120000);
  });
  it("skips busy sessions and resumes at the next interval", async () => {
    enable(); startTurn.mockRejectedValueOnce(new ActiveTurnConflictError("test")); scheduler.start();
    await vi.advanceTimersByTimeAsync(120000);
    expect(scheduler.get("t")?.lastResult).toContain("跳过");
    await vi.advanceTimersByTimeAsync(120000); expect(startTurn).toHaveBeenCalledTimes(2);
  });
  it("does not send while disconnected or paused", async () => {
    enable(); connected = false; scheduler.start();
    await vi.advanceTimersByTimeAsync(240000); expect(startTurn).not.toHaveBeenCalled();
    connected = true; scheduler.set("t", { intervalMinutes: 2, prompt: "检查进展", enabled: false });
    await vi.advanceTimersByTimeAsync(240000); expect(startTurn).not.toHaveBeenCalled();
  });
  it("stops archived schedules and removes deleted project schedules", async () => {
    enable(); repositories.db.prepare("UPDATE project_sessions SET hidden = 1 WHERE thread_id = 't'").run();
    scheduler.start(); await vi.advanceTimersByTimeAsync(120000);
    expect(startTurn).not.toHaveBeenCalled(); expect(scheduler.get("t")?.enabled).toBe(false);
    repositories.deleteProject("p"); expect(scheduler.get("t")).toBeNull();
  });
  it("does not overlap requests or overwrite a pause during sending", async () => {
    let resolve!: (value: Awaited<ReturnType<SessionService["startTurn"]>>) => void;
    startTurn.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    enable(); scheduler.start(); await vi.advanceTimersByTimeAsync(240000);
    expect(startTurn).toHaveBeenCalledTimes(1);
    scheduler.set("t", { intervalMinutes: 5, prompt: "新提示", enabled: false });
    resolve({} as Awaited<ReturnType<SessionService["startTurn"]>>); await scheduler.stop();
    expect(scheduler.get("t")).toMatchObject({ enabled: false, prompt: "新提示", nextRunAt: null });
  });

  const completedTurn = (id: string, text: string): SessionTurn => ({
    id, status: "completed", startedAt: 1, completedAt: 2, durationMs: 1,
    items: [{ type: "agentMessage", id: "reply", text }],
  });

  it("appends the instruction only when enabled and stops on a substring in its own completed Turn", async () => {
    startTurn.mockResolvedValue({ turn: { id: "scheduled-1" } } as Awaited<ReturnType<SessionService["startTurn"]>>);
    scheduler.set("t", { intervalMinutes: 2, prompt: "检查进展", enabled: true, autoStop: true });
    scheduler.start(); await vi.advanceTimersByTimeAsync(120000);
    expect(startTurn.mock.calls[0]?.[1]).toBe(`检查进展\n\n${PromptScheduler.autoStopInstruction}`);
    expect(scheduler.get("t")?.pendingAutoStopTurnId).toBe("scheduled-1");
    scheduler.handleTurnCompleted("t", completedTurn("other-turn", PromptScheduler.completionMarker));
    expect(scheduler.get("t")?.enabled).toBe(true);
    scheduler.handleTurnCompleted("t", completedTurn("scheduled-1", `完成。${PromptScheduler.completionMarker} 谢谢`));
    expect(scheduler.get("t")).toMatchObject({ enabled: false, nextRunAt: null });
    await vi.advanceTimersByTimeAsync(120000);
    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it("checks a previous scheduled reply after restart before sending again", async () => {
    startTurn.mockResolvedValue({ turn: { id: "scheduled-1" } } as Awaited<ReturnType<SessionService["startTurn"]>>);
    scheduler.set("t", { intervalMinutes: 2, prompt: "检查进展", enabled: true, autoStop: true });
    scheduler.start(); await vi.advanceTimersByTimeAsync(120000);
    await scheduler.stop(); repositories.close();
    repositories = new Repositories(path.join(root, "app.db"));
    readSession.mockResolvedValue({ thread: { turns: [completedTurn("scheduled-1", `已完成 ${PromptScheduler.completionMarker}`)] } } as Awaited<ReturnType<SessionService["readSession"]>>);
    scheduler = new PromptScheduler(repositories, { startTurn, readSession }, () => connected);
    scheduler.start(); await vi.advanceTimersByTimeAsync(120000);
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(scheduler.get("t")).toMatchObject({ enabled: false, nextRunAt: null });
  });
});
