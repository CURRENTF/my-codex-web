import { describe, expect, it } from "vitest";
import { browserNotificationControlState, persistTurnCompletionNotificationsEnabled, readTurnCompletionNotificationsEnabled, shouldNotifyTurnCompletion, turnCompletionNotificationCopy } from "../../apps/web/src/browser-notifications";

const turn = {
  threadId: "thread-1",
  turnId: "turn-1",
  status: "completed" as const,
  sessionTitle: "Fix notification delivery",
  activeThreadId: "thread-1",
  documentVisible: true,
};

describe("browser Turn completion notifications", () => {
  it("stores the opt-in per browser profile", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readTurnCompletionNotificationsEnabled(storage)).toBe(false);
    persistTurnCompletionNotificationsEnabled(true, storage);
    expect(readTurnCompletionNotificationsEnabled(storage)).toBe(true);
    persistTurnCompletionNotificationsEnabled(false, storage);
    expect(readTurnCompletionNotificationsEnabled(storage)).toBe(false);
  });

  it("reports enabled, disabled, blocked, and unsupported control states", () => {
    expect(browserNotificationControlState(true, "granted")).toBe("enabled");
    expect(browserNotificationControlState(false, "granted")).toBe("disabled");
    expect(browserNotificationControlState(true, "default")).toBe("disabled");
    expect(browserNotificationControlState(true, "denied")).toBe("blocked");
    expect(browserNotificationControlState(true, "unsupported")).toBe("unsupported");
  });

  it("notifies only when authorized and the completed Session is not already visible", () => {
    expect(shouldNotifyTurnCompletion(turn, true, "granted")).toBe(false);
    expect(shouldNotifyTurnCompletion({ ...turn, documentVisible: false }, true, "granted")).toBe(true);
    expect(shouldNotifyTurnCompletion({ ...turn, activeThreadId: "thread-2" }, true, "granted")).toBe(true);
    expect(shouldNotifyTurnCompletion({ ...turn, documentVisible: false }, false, "granted")).toBe(false);
    expect(shouldNotifyTurnCompletion({ ...turn, documentVisible: false }, true, "denied")).toBe(false);
    expect(shouldNotifyTurnCompletion({ ...turn, documentVisible: false, status: "inProgress" }, true, "granted")).toBe(false);
  });

  it("uses distinct copy for completion, failure, and interruption", () => {
    expect(turnCompletionNotificationCopy("completed", "Session A")).toEqual({ title: "Codex Session 已完成", body: "Session A" });
    expect(turnCompletionNotificationCopy("failed", "Session A").title).toContain("执行失败");
    expect(turnCompletionNotificationCopy("interrupted", "Session A").title).toContain("已中断");
    expect(turnCompletionNotificationCopy("completed", `  ${"long ".repeat(40)}  `).body).toMatch(/^long long .*…$/);
    expect(turnCompletionNotificationCopy("completed", "").body).toBe("点击返回 Codex Web");
  });
});
