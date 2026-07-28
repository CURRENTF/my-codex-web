import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("../../apps/web/src/styles.css", import.meta.url)), "utf8");
const composerSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/components/Composer.tsx", import.meta.url)), "utf8");

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
    expect(rule(".session-pane")).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(rule(".timeline-shell")).toContain("min-height: 0");
  });

  it("keeps scrolling inside the Session list and Timeline", () => {
    expect(rule(".sidebar-list")).toContain("overflow-y: auto");
    expect(rule(".timeline-static")).toContain("overflow-y: auto");
    expect(rule(".timeline-area")).toContain("overflow: hidden");
    expect(rule(".composer textarea")).toContain("overflow-x: hidden");
    expect(rule(".session-notices")).toContain("display: grid");
    expect(rule(".full-access-notice")).not.toContain("grid-area");
    expect(rule(".parallel-write-warning")).not.toContain("grid-area");
  });

  it("keeps the delivery-mode switch compact and visibly stateful", () => {
    expect(rule(".composer-running-controls")).toContain("flex: 0 0 auto");
    expect(styles).not.toContain(".composer-running-controls.is-reserved");
    expect(rule(".delivery-mode-toggle")).toContain("height: 27px");
    expect(rule(".delivery-mode-toggle")).toContain("flex: 0 0 64px");
    expect(rule(".delivery-mode-track")).toContain("width: 22px");
    expect(rule(".composer-running-controls.is-active .delivery-mode-toggle")).toContain("color: var(--accent)");
    expect(rule(".composer-running-controls.is-idle .delivery-mode-toggle")).toContain("opacity: .68");
    expect(rule(".delivery-mode-toggle.queue")).toContain("color: var(--accent)");
    expect(styles).toMatch(/@container session-pane \(max-width: 640px\)[\s\S]*\.delivery-mode-label \{ display: none; \}/);
  });

  it("keeps the running controls visible before a Turn starts so sending cannot reflow the toolbar", () => {
    expect(composerSource).toContain('className={`composer-running-controls ${running ? "is-active" : "is-idle"}`}');
    expect(composerSource).not.toContain("aria-hidden={!running}");
    expect(composerSource).not.toContain('{running && <button type="button" className={`delivery-mode-toggle');
    expect(composerSource).toContain('disabled={!running}');
    expect(composerSource).toContain('"当前没有正在运行的 Turn"');
  });

  it("uses one primary button for sending and stopping", () => {
    expect(composerSource).toContain("const stopPrimaryAction = running && !draft.trim()");
    expect(composerSource).toContain('className={stopPrimaryAction ? "stop-button" : "send-button"}');
    expect(composerSource).toContain("if (stopPrimaryAction) interrupt.mutate()");
    expect(composerSource).not.toMatch(/className="stop-button"/);
    expect(composerSource).not.toMatch(/className="send-button"/);
  });

  it("lets the running Composer toolbar shrink without widening its pane", () => {
    expect(rule(".composer-wrap")).toContain("max-width: 100%");
    expect(rule(".composer-wrap")).toContain("min-width: 0");
    expect(rule(".composer-toolbar")).toContain("display: flex");
    expect(rule(".composer-toolbar")).toContain("flex-wrap: wrap");
    expect(rule(".composer-toolbar")).toContain("min-width: 0");
    expect(rule(".composer-toolbar")).toContain("overflow: hidden");
    expect(rule(".composer-controls")).toContain("flex: 1 1 270px");
    expect(rule(".composer-controls")).toContain("flex-wrap: wrap");
    expect(rule(".composer-controls")).toContain("justify-content: flex-end");
    expect(rule(".composer-controls")).toContain("margin-left: auto");
    expect(rule(".composer-settings")).toContain("min-width: 0");
    expect(rule(".composer-settings")).toContain("justify-content: flex-end");
    expect(rule(".composer-settings")).toContain("overflow: hidden");
    expect(rule(".composer-actions")).toContain("flex: 0 0 auto");
    expect(rule(".access-control, .inline-select")).toContain("min-width: 0");
    expect(rule(".access-control > span, .inline-select > span")).toContain("min-width: 0");
    expect(rule(".access-control > span, .inline-select > span")).toContain("text-overflow: ellipsis");
    expect(rule(".access-control select, .inline-select select")).toContain("position: absolute");
    expect(rule(".access-control select, .inline-select select")).toContain("inset: 0");
    expect(rule(".access-control select, .inline-select select")).toContain("width: 100%");
    expect(rule(".access-control select, .inline-select select")).toContain("opacity: 0");
    expect(composerSource).not.toContain("CaretDown");
    expect(composerSource).toContain('{selectedModel?.displayName ?? model}');
    expect(composerSource).toMatch(/composer-toolbar[\s\S]*access-control[\s\S]*composer-controls[\s\S]*composer-settings[\s\S]*model-select[\s\S]*reasoning-select[\s\S]*composer-actions[\s\S]*composer-running-controls[\s\S]*send-button/);
    expect(rule(".send-button, .stop-button")).toContain("flex: 0 0 29px");
  });
});
