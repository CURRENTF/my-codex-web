import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timeline } from "../../apps/web/src/components/Timeline";

describe("Turn error rendering", () => {
  it("shows the App Server message, retry state, code, HTTP status, and details", () => {
    const html = renderToStaticMarkup(createElement(Timeline, {
      threadId: "thread-1",
      turns: [{
        id: "turn-1",
        status: "completed",
        errors: [{
          message: "Connection reset while streaming",
          code: "responseStreamConnectionFailed",
          httpStatusCode: 503,
          additionalDetails: "upstream temporarily unavailable",
          willRetry: true,
          occurredAt: 1750000000000,
        }],
        items: [],
        startedAt: 10,
        completedAt: 12,
        durationMs: 2_000,
      }] as never,
      canFork: false,
      cwd: "/tmp/project",
      onFork: () => undefined,
      onSideChat: () => undefined,
    }));

    expect(html).toContain("Connection reset while streaming");
    expect(html).toContain("已恢复");
    expect(html).not.toContain("将自动重试");
    expect(html).toContain('dateTime="2025-06-15T15:06:40.000Z"');
    expect(html).toContain("responseStreamConnectionFailed");
    expect(html).toContain("HTTP 503");
    expect(html).toContain("upstream temporarily unavailable");
  });
});


describe("compact error groups at their timeline position", () => {
  it("renders one collapsed retry group before later messages while retaining every occurrence", () => {
    const html = renderToStaticMarkup(createElement(Timeline, {
      threadId: "thread-1", cwd: "/tmp", canFork: false, onFork: () => {}, onSideChat: () => {},
      turns: [{ id: "turn", status: "inProgress", startedAt: 1, completedAt: null, durationMs: null,
        items: [{ type: "agentMessage", id: "before", text: "Before the failure" }, { type: "agentMessage", id: "after", text: "Work resumed after recovery" }],
        errors: [1, 2, 3].map((attempt) => ({ afterItemId: "before", occurredAt: 1750000000000 + attempt * 1000, message: `Reconnecting... ${attempt}/5`, code: "responseStreamDisconnected", httpStatusCode: null, additionalDetails: `attempt details ${attempt}`, willRetry: true })),
      }],
    }));
    expect(html.match(/aria-label="本轮错误记录"/g)).toHaveLength(1);
    expect(html).toContain("3 次");
    expect(html).toContain("后续有进展");
    expect(html).not.toContain("正在重试");
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html.indexOf("Before the failure")).toBeLessThan(html.indexOf('aria-label="本轮错误记录"'));
    expect(html.indexOf('aria-label="本轮错误记录"')).toBeLessThan(html.indexOf("Work resumed after recovery"));
    for (const attempt of [1, 2, 3]) expect(html).toContain(`attempt details ${attempt}`);
  });

  it("shows retrying only while that error is still the latest event", () => {
    const html = renderToStaticMarkup(createElement(Timeline, {
      threadId: "thread-1", cwd: "/tmp", canFork: false, onFork: () => {}, onSideChat: () => {},
      turns: [{ id: "turn", status: "inProgress", startedAt: 1, completedAt: null, durationMs: null,
        items: [{ type: "agentMessage", id: "before", text: "Starting" }],
        errors: [{ afterItemId: "before", message: "Reconnecting... 1/5", code: null, httpStatusCode: null, additionalDetails: null, willRetry: true }],
      }],
    }));
    expect(html).toContain("正在重试");
    expect(html).not.toContain("后续有进展");
  });

  it("labels legacy errors with unknown positions and never claims a failed turn will retry", () => {
    const html = renderToStaticMarkup(createElement(Timeline, {
      threadId: "thread-1", cwd: "/tmp", canFork: false, onFork: () => {}, onSideChat: () => {},
      turns: [{ id: "turn", status: "failed", startedAt: 1, completedAt: 2, durationMs: 1000, items: [],
        errors: [{ message: "Disconnected", code: null, httpStatusCode: null, additionalDetails: null, willRetry: true }],
      }],
    }));
    expect(html).toContain("位置未知");
    expect(html).toContain("发生时间未知");
    expect(html).toContain("本轮失败");
    expect(html).not.toContain("正在重试");
  });
});
