import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

/** Read-only CLI commands. Diagnostics may contain credentials; never return raw stderr. */
export function agyQuery(command: string, cwd: string, args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(command, ["--output-format", "json", ...args], { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error("无法查询 agy。请确认服务用户已安装、登录 agy，并可运行 agy models。")); return; }
      try {
        const result = JSON.parse(stdout);
        if (result.status !== "SUCCESS") throw new Error("query failed");
        resolve(result.command?.data);
      } catch { reject(new Error("agy 返回的查询结果无效，请检查 CLI 版本。")); }
    });
  });
}

/** One process per turn; native conversation IDs carry context across processes. */
export class AgyProcess extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private closed = false;
  private stopping = false;
  private forceTimer?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private failure?: string;
  private result: any;
  private stderrTail = "";
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  constructor(private readonly command: string, private readonly cwd: string) {
    super(); this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }
  start(args: string[], content: string): void {
    this.child = spawn(this.command, ["--mode", "accept-edits", "--dangerously-skip-permissions", "--input-format", "stream-json", "--output-format", "stream-json", ...args], {
      cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    const child = this.child;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Only retain a bounded private tail for timeout detection, never forward diagnostics.
      this.stderrTail = (this.stderrTail + chunk).slice(-4096);
      if (/print timeout|turn in progress/i.test(this.stderrTail)) { this.failure = "agy 执行超时，任务未完成。"; void this.stop(); }
    });
    child.stdout.on("data", (chunk: string) => {
      if (this.failure) return;
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) { this.fail("agy 流式记录超过大小限制。"); return; }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
        if (line) this.record(line);
        if (this.failure) break;
      }
    });
    child.on("error", () => this.fail("无法启动 agy，请检查 CODEX_WEB_AGY_BIN 和服务用户的 CLI 安装。"));
    child.stdin.on("error", () => this.fail("agy 输入连接已关闭。"));
    child.on("close", (code, signal) => {
      if (this.buffer.trim() && !this.failure) this.record(this.buffer.trim());
      this.closed = true; clearTimeout(this.forceTimer); clearTimeout(this.killTimer);
      try { this.emit("finished", { result: this.result, stopped: this.stopping, failure: this.failure, exitOk: code === 0 && !signal }); }
      finally { this.resolveDone(); }
    });
    // EOF makes this exactly one turn. It also avoids shell quoting and argv size limits.
    child.stdin.end(`${JSON.stringify({ event: "user", message: { content } })}\n`);
  }
  private record(line: string): void {
    try {
      const record = JSON.parse(line);
      if (record.event === "result") this.result = record.result;
      this.emit("record", record);
    } catch { this.fail("无法解析或保存 agy 流式输出。"); }
  }
  private fail(message: string) { this.failure ??= message; void this.stop(); }
  async stop(): Promise<void> {
    if (this.closed) return;
    if (!this.stopping) {
      this.stopping = true;
      this.signal("SIGINT");
      this.forceTimer = setTimeout(() => {
        this.failure ??= "agy 未确认停止，已终止其进程组；请检查外部工具是否仍在运行。";
        this.signal("SIGTERM", true);
        this.killTimer = setTimeout(() => this.signal("SIGKILL", true), 1000); this.killTimer.unref();
      }, 5000); this.forceTimer.unref();
    }
    await this.done;
  }
  private signal(signal: NodeJS.Signals, group = false) {
    try {
      if (group && process.platform !== "win32" && this.child?.pid) process.kill(-this.child.pid, signal);
      else this.child?.kill(signal);
    } catch { /* The owned process has already exited. */ }
  }
}
