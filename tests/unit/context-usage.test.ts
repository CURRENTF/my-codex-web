import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextUsageIndicator, presentContextUsage } from "../../apps/web/src/components/ContextUsageIndicator";

describe("context usage indicator", () => {
  it("formats the active context window rather than cumulative Session usage", () => {
    expect(presentContextUsage({ usedTokens: 28_400, maxTokens: 258_000 })).toEqual({
      usedLabel: "28.4k",
      maxLabel: "258k",
      percent: 11,
      progressPercent: 11,
      tone: "normal",
      accessibleLabel: "当前上下文已使用 28.4k / 258k tokens，11%",
    });
  });

  it("uses warning thresholds and caps only the visual progress ring", () => {
    expect(presentContextUsage({ usedTokens: 80, maxTokens: 100 })).toMatchObject({ percent: 80, progressPercent: 80, tone: "warning" });
    expect(presentContextUsage({ usedTokens: 103, maxTokens: 100 })).toMatchObject({ percent: 103, progressPercent: 100, tone: "danger" });
  });

  it("keeps the used count visible when the model window is unavailable", () => {
    expect(presentContextUsage({ usedTokens: 9_800, maxTokens: null })).toMatchObject({
      usedLabel: "9.8k",
      maxLabel: null,
      percent: null,
      progressPercent: null,
    });
  });

  it("renders an accessible progress indicator", () => {
    const html = renderToStaticMarkup(createElement(ContextUsageIndicator, { usage: { usedTokens: 28_400, maxTokens: 258_000 } }));
    expect(html).toContain('class="context-usage normal"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="11"');
    expect(html).toContain('class="context-usage-ring"');
    expect(html).toContain('--context-progress:11%');
    expect(html).not.toContain("context-usage-track");
    expect(html).toContain("28.4k / 258k");
    expect(html).toContain("11%");
  });
});
