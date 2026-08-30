import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countUpdateBlockingExecutions, launchRestartProcess, parseCommandJson, runProcess, SelfUpdateManager, type ProcessRunner, type RestartLauncher } from "../../apps/server/src/self-update";

const temporaryDirectories: string[] = [];
const currentCommit = "1111111111111111111111111111111111111111";
const targetCommit = "2222222222222222222222222222222222222222";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-web-update-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeRunner(options: { dirty?: boolean; upToDate?: boolean; divergent?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  let head = currentCommit;
  const remoteHead = options.upToDate ? currentCommit : targetCommit;
  const runner: ProcessRunner = async (command, args, runOptions) => {
    calls.push({ command, args, cwd: runOptions.cwd });
    const joined = args.join(" ");
    if (command === "git" && joined === "rev-parse HEAD") return { stdout: `${head}\n`, stderr: "" };
    if (command === "git" && joined === "symbolic-ref --quiet --short HEAD") return { stdout: "main\n", stderr: "" };
    if (command === "git" && joined === "status --porcelain=v1 --untracked-files=normal") return { stdout: options.dirty ? " M README.md\n" : "", stderr: "" };
    if (command === "git" && joined === "fetch --no-tags origin main") return { stdout: "", stderr: "" };
    if (command === "git" && joined === "rev-parse FETCH_HEAD^{commit}") return { stdout: `${remoteHead}\n`, stderr: "" };
    if (command === "git" && joined === `merge-base ${currentCommit} ${targetCommit}`) return { stdout: `${options.divergent ? "3333333333333333333333333333333333333333" : currentCommit}\n`, stderr: "" };
    if (command === "git" && joined === `merge --ff-only ${targetCommit}`) { head = targetCommit; return { stdout: "Updating…\n", stderr: "" }; }
    return { stdout: "", stderr: "" };
  };
  const restartLauncher: RestartLauncher = async (command, args, runOptions) => {
    calls.push({ command, args, cwd: runOptions.cwd });
  };
  return { calls, runner, restartLauncher };
}

describe("self update", () => {
  it("counts active Sessions, Side Chats, and restored Subagents once per thread", () => {
    const runtime = (threadId: string, state: "idle" | "running" | "waitingForInput") => ({ threadId, state, activeFlags: [], pendingRequestIds: [] });
    expect(countUpdateBlockingExecutions(
      [runtime("session", "running"), runtime("side-chat", "waitingForInput"), runtime("idle", "idle")],
      [
        { ...runtime("session", "running"), parentThreadId: "parent", agentStatus: "running" as const },
        { ...runtime("restored-subagent", "idle"), parentThreadId: "parent", agentStatus: "pendingInit" as const },
      ],
    )).toBe(3);
  });

  it("accepts only a bounded JSON argv restart command", () => {
    expect(parseCommandJson('["systemctl","--user","restart","my-codex-web.service"]')).toEqual(["systemctl", "--user", "restart", "my-codex-web.service"]);
    expect(parseCommandJson(undefined)).toBeNull();
    expect(() => parseCommandJson("systemctl restart app")).toThrow("JSON 字符串数组");
    expect(() => parseCommandJson("[]")).toThrow("1-32");
  });

  it("does not wait for a spawned restart process that exits by SIGTERM", async () => {
    const directory = await testDirectory();
    await expect(launchRestartProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], { cwd: directory })).resolves.toBeUndefined();
  });

  it("stays unavailable until a server-owned restart command is configured", async () => {
    const directory = await testDirectory();
    const manager = new SelfUpdateManager({ repository: path.join(directory, "repo"), dataDir: path.join(directory, "data"), restartCommand: null });
    await manager.initialize();
    expect(manager.getStatus()).toMatchObject({ enabled: false, state: "unavailable" });
    await expect(manager.start()).rejects.toThrow("重启命令");
  });

  it("fetches without installing when origin/main is already current", async () => {
    const directory = await testDirectory();
    const { calls, runner } = fakeRunner({ upToDate: true });
    const manager = new SelfUpdateManager({ repository: path.join(directory, "repo"), dataDir: path.join(directory, "data"), restartCommand: ["restart-app"], runner });
    await manager.initialize();
    await manager.start();
    await manager.waitForCompletion();
    expect(manager.getStatus()).toMatchObject({ state: "upToDate", currentCommit, targetCommit: currentCommit });
    expect(calls.some((call) => call.command === "npm")).toBe(false);
  });

  it("refuses to fetch over local worktree changes", async () => {
    const directory = await testDirectory();
    const { calls, runner } = fakeRunner({ dirty: true });
    const manager = new SelfUpdateManager({ repository: path.join(directory, "repo"), dataDir: path.join(directory, "data"), restartCommand: ["restart-app"], runner });
    await manager.initialize();
    await manager.start();
    await manager.waitForCompletion();
    expect(manager.getStatus()).toMatchObject({ state: "failed" });
    expect(manager.getStatus().message).toContain("未提交或未跟踪");
    expect(calls.some((call) => call.args[0] === "fetch")).toBe(false);
  });

  it("validates a detached candidate before fast-forwarding and restarting", async () => {
    const directory = await testDirectory();
    const { calls, runner, restartLauncher } = fakeRunner();
    const repository = path.join(directory, "repo");
    const dataDir = path.join(directory, "data");
    const manager = new SelfUpdateManager({ repository, dataDir, restartCommand: ["restart-app", "--now"], runner, restartLauncher });
    await manager.initialize();
    await manager.start();
    await manager.waitForCompletion();

    expect(manager.getStatus()).toMatchObject({ state: "restarting", step: "restarting", currentCommit: targetCommit, targetCommit });
    const commands = calls.map((call) => `${call.command} ${call.args.join(" ")}`);
    const worktreeIndex = commands.findIndex((command) => command.startsWith("git worktree add --detach"));
    const candidateTestIndex = commands.indexOf("npm test");
    const mergeIndex = commands.indexOf(`git merge --ff-only ${targetCommit}`);
    const restartIndex = commands.indexOf("restart-app --now");
    expect(worktreeIndex).toBeGreaterThan(-1);
    expect(candidateTestIndex).toBeGreaterThan(worktreeIndex);
    expect(mergeIndex).toBeGreaterThan(candidateTestIndex);
    expect(restartIndex).toBeGreaterThan(mergeIndex);
    expect(calls.filter((call) => call.command === "npm" && call.args.join(" ") === "ci --include=dev --no-audit --no-fund")).toHaveLength(2);
    expect(calls.filter((call) => call.command === "npm" && call.args.join(" ") === "run build")).toHaveLength(2);

    const replacement = new SelfUpdateManager({ repository, dataDir, restartCommand: ["restart-app", "--now"], runner, restartLauncher });
    await replacement.initialize();
    expect(replacement.getStatus()).toMatchObject({ state: "succeeded", step: "complete", currentCommit: targetCommit, targetCommit });
  });

  it("reports a restart command that cannot be launched without losing the deployed commit", async () => {
    const directory = await testDirectory();
    const { runner } = fakeRunner();
    const manager = new SelfUpdateManager({
      repository: path.join(directory, "repo"),
      dataDir: path.join(directory, "data"),
      restartCommand: ["missing-restart-command"],
      runner,
      restartLauncher: async () => { throw new Error("spawn ENOENT"); },
    });
    await manager.initialize();
    await manager.start();
    await manager.waitForCompletion();
    expect(manager.getStatus()).toMatchObject({ state: "failed", step: "restarting", currentCommit: targetCommit, targetCommit });
    expect(manager.getStatus().message).toContain("spawn ENOENT");
  });

  it("rejects a fetched history that is not a fast-forward successor", async () => {
    const directory = await testDirectory();
    const { calls, runner } = fakeRunner({ divergent: true });
    const manager = new SelfUpdateManager({ repository: path.join(directory, "repo"), dataDir: path.join(directory, "data"), restartCommand: ["restart-app"], runner });
    await manager.initialize();
    await manager.start();
    await manager.waitForCompletion();
    expect(manager.getStatus()).toMatchObject({ state: "failed" });
    expect(manager.getStatus().message).toContain("不是当前版本的快进后继");
    expect(calls.some((call) => call.command === "npm")).toBe(false);
  });

  it("rechecks active work after candidate validation and before changing the live checkout", async () => {
    const directory = await testDirectory();
    const { calls, runner } = fakeRunner();
    const manager = new SelfUpdateManager({
      repository: path.join(directory, "repo"),
      dataDir: path.join(directory, "data"),
      restartCommand: ["restart-app"],
      runner,
      assertSafeToDeploy: () => { throw new Error("验证期间启动了 1 个执行"); },
    });
    await manager.initialize();
    await manager.start();
    await manager.waitForCompletion();
    expect(manager.getStatus()).toMatchObject({ state: "failed", step: "validating" });
    expect(manager.getStatus().message).toContain("验证期间启动了 1 个执行");
    expect(calls.some((call) => call.args[0] === "merge")).toBe(false);
    expect(calls.some((call) => call.command === "restart-app")).toBe(false);
  });

  it("fast-forwards a real local Git remote after an isolated smoke validation", async () => {
    const directory = await testDirectory();
    const upstream = path.join(directory, "upstream");
    const remote = path.join(directory, "remote.git");
    const deployed = path.join(directory, "deployed");
    const command = path.join(directory, "successful-command");
    const run = (executable: string, args: string[], cwd = directory) => runProcess(executable, args, { cwd, timeoutMs: 20_000 });

    await run("git", ["init", "--bare", remote]);
    await run("git", ["init", "-b", "main", upstream]);
    await writeFile(path.join(upstream, "version.txt"), "one\n");
    await run("git", ["add", "version.txt"], upstream);
    await run("git", ["-c", "user.name=Codex Web Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], upstream);
    await run("git", ["remote", "add", "origin", remote], upstream);
    await run("git", ["push", "-u", "origin", "main"], upstream);
    await run("git", ["clone", "--branch", "main", remote, deployed]);
    const initialHead = (await run("git", ["rev-parse", "HEAD"], deployed)).stdout.trim();

    await writeFile(path.join(upstream, "version.txt"), "two\n");
    await run("git", ["add", "version.txt"], upstream);
    await run("git", ["-c", "user.name=Codex Web Test", "-c", "user.email=test@example.invalid", "commit", "-m", "update"], upstream);
    await run("git", ["push", "origin", "main"], upstream);
    const targetHead = (await run("git", ["rev-parse", "HEAD"], upstream)).stdout.trim();
    expect(targetHead).not.toBe(initialHead);

    await writeFile(command, "#!/usr/bin/env node\nprocess.exit(0);\n");
    await chmod(command, 0o700);
    const dataDir = path.join(directory, "data");
    const manager = new SelfUpdateManager({ repository: deployed, dataDir, restartCommand: [command], npmCommand: command });
    await manager.initialize();
    await manager.start();
    await manager.waitForCompletion();

    expect(manager.getStatus()).toMatchObject({ state: "restarting", currentCommit: targetHead, targetCommit: targetHead });
    expect((await run("git", ["rev-parse", "HEAD"], deployed)).stdout.trim()).toBe(targetHead);

    const replacement = new SelfUpdateManager({ repository: deployed, dataDir, restartCommand: [command], npmCommand: command });
    await replacement.initialize();
    expect(replacement.getStatus()).toMatchObject({ state: "succeeded", currentCommit: targetHead, targetCommit: targetHead });
  });
});
