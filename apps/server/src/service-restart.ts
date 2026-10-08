import { randomUUID } from "node:crypto";
import type { ServiceRestartStatus } from "@codex-web/shared-types";
import { launchRestartProcess, type RestartLauncher } from "./self-update.js";

export class ServiceRestartConflictError extends Error {}

export class ServiceRestartManager {
  private readonly instanceId = randomUUID();
  private state: ServiceRestartStatus["state"] = "idle";
  private message = "重启 my-codex-web 服务，恢复连接后自动刷新页面。";
  private launchTimer: NodeJS.Timeout | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: {
    command: string[] | null;
    cwd: string;
    assertSafe: () => void;
    launcher?: RestartLauncher;
  }) {}

  getStatus(): ServiceRestartStatus {
    return {
      enabled: this.options.command !== null,
      instanceId: this.instanceId,
      state: this.state,
      message: this.options.command ? this.message : "服务端尚未配置重启命令。",
    };
  }

  start(): ServiceRestartStatus {
    if (!this.options.command) throw new ServiceRestartConflictError("服务端尚未配置重启命令。");
    if (this.state === "restarting") throw new ServiceRestartConflictError("服务正在重启，请稍候。");
    this.options.assertSafe();
    this.state = "restarting";
    this.message = "正在重启 my-codex-web，等待服务恢复…";
    // Let the accepted HTTP response reach the browser before stopping this process.
    this.launchTimer = setTimeout(() => { void this.launch(); }, 500);
    this.launchTimer.unref();
    this.timeoutTimer = setTimeout(() => this.fail("未检测到服务重启，请检查服务端重启命令后重试。"), 30_000);
    this.timeoutTimer.unref();
    return this.getStatus();
  }

  private async launch(): Promise<void> {
    try {
      this.options.assertSafe();
      const [command, ...args] = this.options.command!;
      await (this.options.launcher ?? launchRestartProcess)(command!, args, { cwd: this.options.cwd });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "启动重启命令失败。");
    }
  }

  private fail(message: string): void {
    this.dispose();
    this.state = "failed";
    this.message = message;
  }

  dispose(): void {
    if (this.launchTimer) clearTimeout(this.launchTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.launchTimer = null;
    this.timeoutTimer = null;
  }
}
