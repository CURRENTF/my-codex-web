import { randomUUID } from "node:crypto";
import type { PromptSchedule } from "@codex-web/shared-types";
import type { Repositories } from "./database.js";
import { ActiveTurnConflictError, SessionDisconnectedError, type SessionService } from "./session-service.js";

/** Durable server-owned schedules. Claim before sending: missed ticks never accumulate. */
export class PromptScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Set<Promise<void>>();
  private running = new Set<string>();

  constructor(private repositories: Repositories, private sessions: Pick<SessionService, "startTurn">, private connected: () => boolean) {
    repositories.db.exec(`CREATE TABLE IF NOT EXISTS prompt_schedules (
      thread_id TEXT PRIMARY KEY REFERENCES project_sessions(thread_id) ON DELETE CASCADE,
      value TEXT NOT NULL
    )`);
  }

  get(threadId: string): PromptSchedule | null {
    const row = this.repositories.db.prepare("SELECT value FROM prompt_schedules WHERE thread_id = ?").get(threadId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as PromptSchedule : null;
  }

  set(threadId: string, input: Pick<PromptSchedule, "intervalMinutes" | "prompt" | "enabled">): PromptSchedule {
    const mapping = this.repositories.getProjectSession(threadId);
    if (!mapping || mapping.hidden) throw new Error("任务不存在或已归档");
    const value: PromptSchedule = { threadId, ...input, nextRunAt: input.enabled ? Date.now() + input.intervalMinutes * 60_000 : null, lastRunAt: this.get(threadId)?.lastRunAt ?? null, lastResult: null };
    this.write(value);
    return value;
  }

  private write(value: PromptSchedule): void {
    this.repositories.db.prepare("INSERT INTO prompt_schedules VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET value = excluded.value").run(value.threadId, JSON.stringify(value));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  tick(now = Date.now()): void {
    if (!this.connected()) return;
    const rows = this.repositories.db.prepare("SELECT value FROM prompt_schedules").all() as { value: string }[];
    for (const row of rows) {
      const schedule = JSON.parse(row.value) as PromptSchedule;
      if (!schedule.enabled) continue;
      const mapping = this.repositories.getProjectSession(schedule.threadId);
      if (!mapping || mapping.hidden) {
        this.write({ ...schedule, enabled: false, nextRunAt: null, lastResult: "任务已归档，轮询已暂停" });
        continue;
      }
      if (schedule.nextRunAt === null || schedule.nextRunAt > now || this.running.has(schedule.threadId)) continue;
      schedule.nextRunAt = now + schedule.intervalMinutes * 60_000;
      schedule.lastRunAt = now;
      schedule.lastResult = "正在发送";
      this.write(schedule);
      this.running.add(schedule.threadId);
      const job = this.send(schedule).finally(() => { this.running.delete(schedule.threadId); this.pending.delete(job); });
      this.pending.add(job);
    }
  }

  private async send(schedule: PromptSchedule): Promise<void> {
    let result = "已发送";
    try {
      await this.sessions.startTurn(schedule.threadId, schedule.prompt, { clientUserMessageId: randomUUID() }, randomUUID(), true);
    } catch (error) {
      result = error instanceof ActiveTurnConflictError ? "任务仍在运行，本次已跳过"
        : error instanceof SessionDisconnectedError ? "任务暂不可用，本次已跳过" : "发送失败，下个周期重试；请检查任务状态";
    }
    const current = this.get(schedule.threadId);
    // A user may edit or pause a schedule while the request is in flight.
    if (current && current.lastRunAt === schedule.lastRunAt) this.write({ ...current, lastResult: result });
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.pending]);
  }
}
