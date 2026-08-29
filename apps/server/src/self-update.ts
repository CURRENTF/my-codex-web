import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeState, SelfUpdateStatus, SubagentAgentStatus } from "@codex-web/shared-types";

const COMMAND_OUTPUT_LIMIT = 24_000;
const GIT_TIMEOUT_MS = 2 * 60_000;
const NPM_TIMEOUT_MS = 20 * 60_000;
const RESTART_TIMEOUT_MS = 60_000;

export interface ProcessRunOptions {
  cwd: string;
  timeoutMs: number;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (command: string, args: string[], options: ProcessRunOptions) => Promise<ProcessRunResult>;

interface UpdateExecutionState {
  threadId: string;
  state: RuntimeState;
  agentStatus?: SubagentAgentStatus;
}

export function countUpdateBlockingExecutions(...groups: ReadonlyArray<ReadonlyArray<UpdateExecutionState>>): number {
  const activeThreadIds = new Set<string>();
  for (const group of groups) {
    for (const execution of group) {
      if (execution.state === "running" || execution.state === "waitingForInput" || execution.agentStatus === "pendingInit" || execution.agentStatus === "running") {
        activeThreadIds.add(execution.threadId);
      }
    }
  }
  return activeThreadIds.size;
}

function boundedAppend(current: string, addition: string): string {
  const combined = current + addition;
  return combined.length <= COMMAND_OUTPUT_LIMIT ? combined : combined.slice(-COMMAND_OUTPUT_LIMIT);
}

export const runProcess: ProcessRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, options.timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk.toString()); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk.toString()); });
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    if (timedOut) return reject(new Error(`${command} 执行超时。`));
    if (code === 0) return resolve({ stdout, stderr });
    const detail = stderr.trim() || stdout.trim() || (signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`);
    reject(new Error(`${command} 执行失败：${detail}`));
  });
});

export function parseCommandJson(value: string | undefined, name = "CODEX_WEB_UPDATE_RESTART_COMMAND_JSON"): string[] | null {
  if (!value?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} 必须是 JSON 字符串数组。`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32 || parsed.some((item) => typeof item !== "string" || !item.trim() || item.length > 1_000)) {
    throw new Error(`${name} 必须是包含 1-32 个非空参数的 JSON 字符串数组。`);
  }
  return parsed as string[];
}

function validateGitName(value: string, name: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(trimmed) || trimmed.includes("..") || trimmed.endsWith("/") || trimmed.includes("//")) {
    throw new Error(`${name} 不是安全的 Git 名称。`);
  }
  return trimmed;
}

export interface SelfUpdateManagerOptions {
  repository: string;
  dataDir: string;
  remote?: string;
  branch?: string;
  restartCommand: string[] | null;
  runner?: ProcessRunner;
  npmCommand?: string;
  assertSafeToDeploy?: () => Promise<void> | void;
}

export class SelfUpdateUnavailableError extends Error {}
export class SelfUpdateConflictError extends Error {}

export class SelfUpdateManager {
  private readonly repository: string;
  private readonly dataDir: string;
  private readonly remote: string;
  private readonly branch: string;
  private readonly restartCommand: string[] | null;
  private readonly runner: ProcessRunner;
  private readonly npmCommand: string;
  private readonly assertSafeToDeploy: () => Promise<void> | void;
  private readonly statusPath: string;
  private readonly updateRoot: string;
  private activeTask: Promise<void> | null = null;
  private status: SelfUpdateStatus;

  constructor(options: SelfUpdateManagerOptions) {
    this.repository = path.resolve(options.repository);
    this.dataDir = path.resolve(options.dataDir);
    this.remote = validateGitName(options.remote ?? "origin", "CODEX_WEB_UPDATE_REMOTE");
    this.branch = validateGitName(options.branch ?? "main", "CODEX_WEB_UPDATE_BRANCH");
    this.restartCommand = options.restartCommand;
    this.runner = options.runner ?? runProcess;
    this.npmCommand = options.npmCommand ?? "npm";
    this.assertSafeToDeploy = options.assertSafeToDeploy ?? (() => undefined);
    this.statusPath = path.join(this.dataDir, "self-update.json");
    this.updateRoot = path.join(this.dataDir, "updates");
    this.status = this.defaultStatus();
  }

  private defaultStatus(): SelfUpdateStatus {
    const enabled = this.restartCommand !== null;
    return {
      enabled,
      state: enabled ? "idle" : "unavailable",
      step: enabled ? "idle" : "unavailable",
      repository: this.repository,
      remote: this.remote,
      branch: this.branch,
      runId: null,
      currentCommit: null,
      targetCommit: null,
      startedAt: null,
      finishedAt: null,
      message: enabled ? "可以检查 GitHub 更新。" : "服务端尚未配置更新后的重启命令。",
    };
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    let persisted: SelfUpdateStatus | null = null;
    try {
      persisted = JSON.parse(await readFile(this.statusPath, "utf8")) as SelfUpdateStatus;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") persisted = null;
    }
    if (!this.restartCommand) {
      const status = this.defaultStatus();
      try {
        status.currentCommit = await this.gitOutput(["rev-parse", "HEAD"]);
      } catch {
        // Keep the button discoverable but disabled for package/archive installs without Git metadata.
      }
      await this.replaceStatus(status);
      return;
    }
    try {
      const currentCommit = await this.gitOutput(["rev-parse", "HEAD"]);
      const base = persisted?.repository === this.repository && persisted.remote === this.remote && persisted.branch === this.branch
        ? { ...this.defaultStatus(), ...persisted, enabled: true, currentCommit }
        : { ...this.defaultStatus(), currentCommit };
      if (base.state === "restarting" && base.targetCommit === currentCommit) {
        await this.replaceStatus({ ...base, state: "succeeded", step: "complete", finishedAt: Date.now(), message: "更新已完成，服务已重新启动。" });
      } else if (base.state === "running" || base.state === "restarting") {
        await this.replaceStatus({ ...base, state: "failed", step: base.step, finishedAt: Date.now(), message: "上一次更新任务意外中断，请检查更新日志后重试。" });
      } else {
        await this.replaceStatus(base);
      }
    } catch (error) {
      await this.replaceStatus({ ...this.defaultStatus(), enabled: true, state: "unavailable", step: "unavailable", message: this.errorMessage(error) });
    }
  }

  getStatus(): SelfUpdateStatus {
    return { ...this.status };
  }

  async start(): Promise<SelfUpdateStatus> {
    if (!this.restartCommand || this.status.state === "unavailable") throw new SelfUpdateUnavailableError(this.status.message);
    if (this.activeTask || this.status.state === "running" || this.status.state === "restarting") throw new SelfUpdateConflictError("已有更新任务正在执行。");
    const runId = randomUUID();
    const retryDeployedCommit = this.status.state === "failed" && (this.status.step === "deploying" || this.status.step === "restarting")
      ? this.status.targetCommit
      : null;
    await this.patchStatus({
      state: "running",
      step: "checking",
      runId,
      targetCommit: null,
      startedAt: Date.now(),
      finishedAt: null,
      message: `正在检查 ${this.remote}/${this.branch}…`,
    });
    this.activeTask = this.execute(runId, retryDeployedCommit)
      .catch(async (error) => {
        await this.patchStatus({ state: "failed", finishedAt: Date.now(), message: this.errorMessage(error) });
      })
      .finally(() => { this.activeTask = null; });
    return this.getStatus();
  }

  async waitForCompletion(): Promise<void> {
    await this.activeTask;
  }

  private async execute(runId: string, retryDeployedCommit: string | null): Promise<void> {
    await mkdir(this.updateRoot, { recursive: true, mode: 0o700 });
    const currentBranch = await this.gitOutput(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (currentBranch !== this.branch) throw new Error(`当前分支是 ${currentBranch}，更新要求检出 ${this.branch}。`);
    const currentCommit = await this.gitOutput(["rev-parse", "HEAD"]);
    await this.patchStatus({ currentCommit });
    const dirty = await this.gitOutput(["status", "--porcelain=v1", "--untracked-files=normal"]);
    if (dirty) throw new Error("运行目录存在未提交或未跟踪的改动，已拒绝自动更新。请先提交、转移或清理这些改动。");

    await this.loggedRun(runId, "git", ["fetch", "--no-tags", this.remote, this.branch], this.repository, GIT_TIMEOUT_MS);
    const targetCommit = await this.gitOutput(["rev-parse", "FETCH_HEAD^{commit}"]);
    await this.patchStatus({ targetCommit });
    if (currentCommit === targetCommit) {
      if (retryDeployedCommit === targetCommit) {
        await this.deployAndRestart(runId, targetCommit, false);
        return;
      }
      await this.patchStatus({ state: "upToDate", step: "complete", finishedAt: Date.now(), message: `${this.remote}/${this.branch} 已是最新版本。` });
      return;
    }
    const mergeBase = await this.gitOutput(["merge-base", currentCommit, targetCommit]);
    if (mergeBase !== currentCommit) throw new Error("远端更新不是当前版本的快进后继，已拒绝自动合并。");

    const candidate = path.join(this.updateRoot, `candidate-${runId}`);
    let worktreeAdded = false;
    try {
      await this.patchStatus({ step: "installing", message: "正在隔离候选版本并安装依赖…" });
      await this.loggedRun(runId, "git", ["worktree", "add", "--detach", candidate, targetCommit], this.repository, GIT_TIMEOUT_MS);
      worktreeAdded = true;
      await this.loggedRun(runId, this.npmCommand, ["ci", "--no-audit", "--no-fund"], candidate, NPM_TIMEOUT_MS);
      await this.patchStatus({ step: "validating", message: "正在检查、测试并构建候选版本…" });
      await this.loggedRun(runId, this.npmCommand, ["run", "check"], candidate, NPM_TIMEOUT_MS);
      await this.loggedRun(runId, this.npmCommand, ["test"], candidate, NPM_TIMEOUT_MS);
      await this.loggedRun(runId, this.npmCommand, ["run", "build"], candidate, NPM_TIMEOUT_MS);
    } finally {
      if (worktreeAdded) {
        try {
          await this.loggedRun(runId, "git", ["worktree", "remove", "--force", candidate], this.repository, GIT_TIMEOUT_MS);
        } catch (error) {
          await this.appendLog(runId, `候选 worktree 清理失败：${this.errorMessage(error)}\n`);
        }
      }
      await rm(candidate, { recursive: true, force: true });
    }

    const branchBeforeDeploy = await this.gitOutput(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const headBeforeDeploy = await this.gitOutput(["rev-parse", "HEAD"]);
    const dirtyBeforeDeploy = await this.gitOutput(["status", "--porcelain=v1", "--untracked-files=normal"]);
    if (branchBeforeDeploy !== this.branch || headBeforeDeploy !== currentCommit || dirtyBeforeDeploy) {
      throw new Error("候选版本验证期间运行目录发生变化，已取消部署。");
    }

    await this.deployAndRestart(runId, targetCommit, true);
  }

  private async deployAndRestart(runId: string, targetCommit: string, fastForward: boolean): Promise<void> {
    await this.assertSafeToDeploy();
    await this.patchStatus({ step: "deploying", message: fastForward ? "候选版本验证通过，正在快进部署…" : "正在恢复已验证版本的构建和重启…" });
    if (fastForward) await this.loggedRun(runId, "git", ["merge", "--ff-only", targetCommit], this.repository, GIT_TIMEOUT_MS);
    await this.loggedRun(runId, this.npmCommand, ["ci", "--no-audit", "--no-fund"], this.repository, NPM_TIMEOUT_MS);
    await this.loggedRun(runId, this.npmCommand, ["run", "build"], this.repository, NPM_TIMEOUT_MS);

    await this.patchStatus({ state: "restarting", step: "restarting", currentCommit: targetCommit, message: "部署完成，正在重新启动 Codex Web…" });
    const [command, ...args] = this.restartCommand!;
    await this.loggedRun(runId, command!, args, this.repository, RESTART_TIMEOUT_MS);
    await this.patchStatus({ state: "succeeded", step: "complete", finishedAt: Date.now(), message: "更新已完成；请刷新页面使用新版本。" });
  }

  private async gitOutput(args: string[]): Promise<string> {
    return (await this.runner("git", args, { cwd: this.repository, timeoutMs: GIT_TIMEOUT_MS })).stdout.trim();
  }

  private async loggedRun(runId: string, command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessRunResult> {
    await this.appendLog(runId, `[${new Date().toISOString()}] ${command} ${args.join(" ")}\n`);
    try {
      const result = await this.runner(command, args, { cwd, timeoutMs });
      if (result.stdout) await this.appendLog(runId, result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
      if (result.stderr) await this.appendLog(runId, result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
      return result;
    } catch (error) {
      await this.appendLog(runId, `${this.errorMessage(error)}\n`);
      throw error;
    }
  }

  private async appendLog(runId: string, content: string): Promise<void> {
    const logDir = path.join(this.dataDir, "logs");
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    await appendFile(path.join(logDir, `update-${runId}.log`), content, { encoding: "utf8", mode: 0o600 });
  }

  private async patchStatus(changes: Partial<SelfUpdateStatus>): Promise<void> {
    await this.replaceStatus({ ...this.status, ...changes });
  }

  private async replaceStatus(status: SelfUpdateStatus): Promise<void> {
    this.status = status;
    const temporary = `${this.statusPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.statusPath);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "更新失败，请检查服务端更新日志。";
  }
}
