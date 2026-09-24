import { randomUUID } from "node:crypto";
import type { PromptSchedule, SessionTurn } from "@codex-web/shared-types";
import type { Repositories } from "./database.js";
import { ActiveTurnConflictError, SessionDisconnectedError, type SessionService } from "./session-service.js";

/** Durable server-owned schedules. Claim before sending: missed ticks never accumulate. */
export class PromptScheduler {
  static readonly completionMarker = "Toutes les tâches ont été parfaitement accomplies.";
  static readonly autoStopInstruction = `当你认为交给你的任务都已经完成，不需要再重复轮询你，请原字原样输出“${PromptScheduler.completionMarker}”`;
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Set<Promise<void>>();
  private running = new Set<string>();

  constructor(private repositories: Repositories, private sessions: Pick<SessionService, "startTurn" | "readSession">, private connected: () => boolean) {
    repositories.db.exec(`CREATE TABLE IF NOT EXISTS prompt_schedules (
      thread_id TEXT PRIMARY KEY REFERENCES project_sessions(thread_id) ON DELETE CASCADE,
      value TEXT NOT NULL
    )`);
  }

  get(threadId: string): PromptSchedule | null {
    const row = this.repositories.db.prepare("SELECT value FROM prompt_schedules WHERE thread_id = ?").get(threadId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as PromptSchedule : null;
  }

  set(threadId: string, input: Pick<PromptSchedule, "intervalMinutes" | "prompt" | "enabled"> & { autoStop?: boolean }): PromptSchedule {
    const mapping = this.repositories.getProjectSession(threadId);
    if (!mapping || mapping.hidden) throw new Error("任务不存在或已归档");
    const value: PromptSchedule = { threadId, ...input, autoStop: input.autoStop ?? false, scheduleId: randomUUID(), pendingAutoStopTurnId: null, nextRunAt: input.enabled ? Date.now() + input.intervalMinutes * 60_000 : null, lastRunAt: this.get(threadId)?.lastRunAt ?? null, lastResult: null };
    this.write(value);
    return value;
  }

  private write(value: PromptSchedule): void {
    this.repositories.db.prepare("INSERT INTO prompt_schedules VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET value = excluded.value").run(value.threadId, JSON.stringify(value));
  }

  handleTurnCompleted(threadId: string, turn: SessionTurn): void {
    const schedule = this.get(threadId);
    if (schedule?.enabled && schedule.autoStop && schedule.pendingAutoStopTurnId === turn.id
      && turn.status === "completed" && this.containsCompletionMarker(turn)) {
      this.write({ ...schedule, enabled: false, nextRunAt: null, pendingAutoStopTurnId: null, lastResult: "模型已确认任务完成，轮询已自动暂停" });
    }
  }

  private containsCompletionMarker(turn: SessionTurn): boolean {
    return turn.items.some((item) => item.type === "agentMessage" && item.text.includes(PromptScheduler.completionMarker));
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
      if (schedule.autoStop && schedule.pendingAutoStopTurnId) {
        const { thread } = await this.sessions.readSession(schedule.threadId);
        const previous = thread.turns.find((turn) => turn.id === schedule.pendingAutoStopTurnId);
        if (!previous || previous.status === "inProgress") {
          result = "上次轮询仍在运行，本次已跳过";
          const current = this.get(schedule.threadId);
          if (current && current.scheduleId === schedule.scheduleId && current.lastRunAt === schedule.lastRunAt) this.write({ ...current, lastResult: result });
          return;
        }
        if (previous.status === "completed" && this.containsCompletionMarker(previous)) {
          const current = this.get(schedule.threadId);
          if (current?.enabled && current.scheduleId === schedule.scheduleId && current.pendingAutoStopTurnId === previous.id) {
            this.write({ ...current, enabled: false, nextRunAt: null, pendingAutoStopTurnId: null, lastResult: "模型已确认任务完成，轮询已自动暂停" });
          }
          return;
        }
      }
      if (this.get(schedule.threadId)?.scheduleId !== schedule.scheduleId) return;
      const prompt = schedule.autoStop ? `${schedule.prompt}\n\n${PromptScheduler.autoStopInstruction}` : schedule.prompt;
      const response = await this.sessions.startTurn(schedule.threadId, prompt, { clientUserMessageId: randomUUID() }, randomUUID(), true);
      const current = this.get(schedule.threadId);
      if (current?.enabled && current.scheduleId === schedule.scheduleId && current.lastRunAt === schedule.lastRunAt) {
        this.write({ ...current, pendingAutoStopTurnId: schedule.autoStop ? response.turn.id : null, lastResult: result });
      }
    } catch (error) {
      result = error instanceof ActiveTurnConflictError ? "任务仍在运行，本次已跳过"
        : error instanceof SessionDisconnectedError ? "任务暂不可用，本次已跳过" : "发送失败，下个周期重试；请检查任务状态";
      const current = this.get(schedule.threadId);
      if (current && current.scheduleId === schedule.scheduleId && current.lastRunAt === schedule.lastRunAt) this.write({ ...current, lastResult: result });
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.pending]);
  }
}
