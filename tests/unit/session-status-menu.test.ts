import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RuntimeState } from "@codex-web/shared-types";
import { SessionStatusMenuIcon } from "../../apps/web/src/components/Sidebar";

const states: RuntimeState[] = ["idle", "running", "waitingForInput", "justFinished", "interrupted", "failed", "disconnected"];

describe("Session status menu", () => {
  it("renders a distinct non-color glyph for every runtime state", () => {
    const markup = states.map((state) => renderToStaticMarkup(createElement(SessionStatusMenuIcon, { state })));

    expect(new Set(markup).size).toBe(states.length);
    for (const html of markup) {
      expect(html).toContain('class="session-status-menu-icon"');
      expect(html).toContain('class="session-status-more-icon"');
      expect(html).toContain('aria-hidden="true"');
    }
    expect(markup[1]).toContain("spinning");
    expect(markup.at(-1)).toContain("danger");
  });
});
