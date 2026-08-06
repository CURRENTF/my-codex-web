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
        status: "failed",
        errors: [{
          message: "Connection reset while streaming",
          code: "responseStreamConnectionFailed",
          httpStatusCode: 503,
          additionalDetails: "upstream temporarily unavailable",
          willRetry: true,
        }],
        items: [],
        startedAt: 10,
        completedAt: 12,
        durationMs: 2_000,
      }] as never,
      canFork: false,
      codeServer: { url: null, state: "unconfigured", checkedAt: null },
      cwd: "/tmp/project",
      onFork: () => undefined,
      onSideChat: () => undefined,
    }));

    expect(html).toContain("Connection reset while streaming");
    expect(html).toContain("将自动重试");
    expect(html).toContain("responseStreamConnectionFailed");
    expect(html).toContain("HTTP 503");
    expect(html).toContain("upstream temporarily unavailable");
  });
});
