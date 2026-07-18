import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("../../apps/web/src/styles.css", import.meta.url)), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
}

describe("viewport layout CSS", () => {
  it("lets every grid and pane shrink below its content height", () => {
    expect(rule(".app-shell")).toContain("grid-template-rows: minmax(0, 1fr)");
    expect(rule(".workspace-layout")).toContain("grid-template-rows: minmax(0, 1fr)");
    expect(rule(".sidebar")).toContain("min-height: 0");
    expect(rule(".main-pane, .side-pane")).toContain("min-height: 0");
    expect(rule(".session-pane")).toContain("min-height: 0");
    expect(rule(".timeline-shell")).toContain("min-height: 0");
  });

  it("keeps scrolling inside the Session list and Timeline", () => {
    expect(rule(".sidebar-list")).toContain("overflow-y: auto");
    expect(rule(".timeline-static")).toContain("overflow-y: auto");
    expect(rule(".timeline-area")).toContain("overflow: hidden");
  });
});
