import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceRestartManager } from "../../apps/server/src/service-restart";

afterEach(() => { vi.useRealTimers(); });

function setup(command: string[] | null = ["systemctl", "--user", "restart", "my-codex-web.service"]) {
  vi.useFakeTimers();
  const launcher = vi.fn(async () => undefined);
  const assertSafe = vi.fn(() => undefined);
  const manager = new ServiceRestartManager({ command, cwd: "/app", launcher, assertSafe });
  return { manager, launcher, assertSafe };
}

describe("service restart", () => {
  it("requires a server-configured command", () => {
    const { manager, launcher } = setup(null);
    expect(manager.getStatus().enabled).toBe(false);
    expect(() => manager.start()).toThrow("尚未配置");
    expect(launcher).not.toHaveBeenCalled();
  });

  it("accepts once, then launches only the configured argv after the response delay", async () => {
    const { manager, launcher, assertSafe } = setup();
    const status = manager.start();
    expect(status.state).toBe("restarting");
    expect(launcher).not.toHaveBeenCalled();
    expect(() => manager.start()).toThrow("正在重启");
    await vi.advanceTimersByTimeAsync(500);
    expect(launcher).toHaveBeenCalledExactlyOnceWith("systemctl", ["--user", "restart", "my-codex-web.service"], { cwd: "/app" });
    expect(assertSafe).toHaveBeenCalledTimes(2);
    expect(manager.getStatus().instanceId).toBe(status.instanceId);
    const replacement = setup().manager;
    expect(replacement.getStatus().instanceId).not.toBe(status.instanceId);
    manager.dispose();
  });

  it.each(["仍有任务在运行", "正在更新"])("refuses unsafe work: %s", async (message) => {
    const { manager, launcher, assertSafe } = setup();
    assertSafe.mockImplementation(() => { throw new Error(message); });
    expect(() => manager.start()).toThrow(message);
    expect(manager.getStatus().state).toBe("idle");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(launcher).not.toHaveBeenCalled();
  });

  it("rechecks work that started during the response delay", async () => {
    const { manager, launcher, assertSafe } = setup();
    manager.start();
    assertSafe.mockImplementation(() => { throw new Error("任务开始运行"); });
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.getStatus()).toMatchObject({ state: "failed", message: "任务开始运行" });
    expect(launcher).not.toHaveBeenCalled();
  });

  it("reports launch failures and allows a retry", async () => {
    const { manager, launcher } = setup();
    launcher.mockRejectedValueOnce(new Error("spawn ENOENT"));
    manager.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.getStatus()).toMatchObject({ state: "failed", message: "spawn ENOENT" });
    manager.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(launcher).toHaveBeenCalledTimes(2);
    expect(manager.getStatus().state).toBe("restarting");
    manager.dispose();
  });

  it("does not report success when a spawned command leaves the old service alive", async () => {
    const { manager } = setup();
    manager.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.getStatus()).toMatchObject({ state: "failed", message: expect.stringContaining("未检测到服务重启") });
  });

  it("cancels a pending launch when the server closes", async () => {
    const { manager, launcher } = setup();
    manager.start();
    manager.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(launcher).not.toHaveBeenCalled();
  });
});
