import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SESSION_SWIPE_ACTION_WIDTH, sessionSwipeIsRevealed } from "../../apps/web/src/components/Sidebar";

const styles = readFileSync(fileURLToPath(new URL("../../apps/web/src/styles.css", import.meta.url)), "utf8");
const appSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/App.tsx", import.meta.url)), "utf8");
const composerSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/components/Composer.tsx", import.meta.url)), "utf8");
const settingsSelectSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/components/SettingsSelect.tsx", import.meta.url)), "utf8");
const serviceTierSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/service-tier.ts", import.meta.url)), "utf8");
const sessionPaneSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/components/SessionPane.tsx", import.meta.url)), "utf8");
const sidebarSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/components/Sidebar.tsx", import.meta.url)), "utf8");
const selfUpdateSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/components/SelfUpdateControl.tsx", import.meta.url)), "utf8");
const timelineSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/components/Timeline.tsx", import.meta.url)), "utf8");

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

  it("reveals bounded Session shortcuts only in the mobile Sidebar", () => {
    expect(sessionSwipeIsRevealed(SESSION_SWIPE_ACTION_WIDTH / 2 - 1)).toBe(false);
    expect(sessionSwipeIsRevealed(SESSION_SWIPE_ACTION_WIDTH / 2)).toBe(true);
    expect(rule(".session-swipe-actions")).toContain("display: none");
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*\.session-swipe-actions \{[^}]*display: flex;/);
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*\.session-swipe-track \{[^}]*overflow-x: auto;[^}]*scroll-snap-type: x mandatory;/);
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*\.session-row-content \{[^}]*scroll-snap-align: start;/);
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*\.session-swipe-actions \{[^}]*scroll-snap-align: end;/);
    expect(sidebarSource).not.toContain("setPointerCapture");
    expect(sidebarSource).not.toContain("onPointerMove");
    expect(sidebarSource).not.toContain("setDragOffset");
    expect(sidebarSource).not.toContain("settleTimer");
    expect(sidebarSource).toContain("onScrollEnd={settleScroll}");
    expect(sidebarSource).toContain("programmaticTarget.current");
    expect(sidebarSource).toContain('className="session-swipe-action archive"');
  });

  it("combines each Session status and action menu into one visible control", () => {
    expect(sidebarSource).toContain("DotsThreeCircle");
    expect(sidebarSource).toContain("statusText(runtimeState)");
    expect(sidebarSource).toContain("session-status-menu ${runtimeState}");
    expect(sidebarSource).not.toContain('<StatusIcon state={runtimeState} />');
    expect(sidebarSource).not.toContain("session-row-more");
    expect(rule(".session-status-menu")).toContain("display: grid");
    expect(rule(".session-status-menu")).not.toContain("opacity: 0");
    expect(rule(".session-status-more-icon")).toContain("opacity: 0");
    expect(rule('.session-status-menu[data-state="open"] .session-status-more-icon')).toContain("opacity: 1");
    expect(rule(".session-status-menu.running")).toContain("color: var(--accent)");
    expect(rule(".session-status-menu.justFinished")).toContain("color: var(--success)");
    expect(rule(".session-status-menu.waitingForInput")).toContain("color: var(--warning)");
    expect(styles).not.toMatch(/@media \(max-width: 720px\)[\s\S]*\.session-status-menu \{[^}]*display: none;/);
  });

  it("lets long prompts grow until half the visible page", () => {
    expect(rule(".composer textarea")).toContain("min-height: 64px");
    expect(rule(".composer textarea")).toContain("max-height: 50dvh");
    expect(rule(".composer textarea")).toContain("overflow-y: hidden");
    expect(composerSource).toContain("resizeComposerTextarea(textarea.current)");
    expect(composerSource).toContain('window.visualViewport?.addEventListener("resize", resize)');
  });

  it("keeps short text messages content-sized while reserving preview width for attachments", () => {
    expect(rule(".user-message > div")).not.toContain("min-width");
    expect(rule(".message-with-attachments")).toContain("min-width: min(220px, 86%)");
    expect(timelineSource.match(/message-with-attachments/g)).toHaveLength(2);
  });

  it("restores visible Markdown list markers and nested hierarchy after Tailwind preflight", () => {
    expect(styles).toContain(".agent-message-text ul { list-style-type: disc; }");
    expect(styles).toContain(".agent-message-text ol { list-style-type: decimal; }");
    expect(styles).toContain(".agent-message-text ul ul { list-style-type: circle; }");
    expect(styles).toContain(".agent-message-text ul ul ul { list-style-type: square; }");
    expect(rule(".agent-message-text li > ul, .agent-message-text li > ol")).toContain("padding-left: 1.45em");
  });

  it("keeps the portaled Goal editor inside the viewport", () => {
    expect(rule(".goal-popover")).toContain("width: min(390px, calc(100vw - 24px))");
  });

  it("keeps Goal in the Session header action row and collapses it to an icon in narrow panes", () => {
    expect(sessionPaneSource).toMatch(/<header className="session-header">[\s\S]*<GoalBar[\s\S]*Side Chat[\s\S]*code-server[\s\S]*<\/header>/);
    expect(rule(".session-pane")).not.toContain('"goal"');
    expect(rule(".goal-bar")).toContain("max-width: min(310px, 31cqw)");
    expect(styles).toMatch(/@container session-pane \(max-width: 760px\)[\s\S]*\.goal-bar \{ width: 32px; max-width: 32px; flex: 0 0 32px; \}/);
  });

  it("keeps long Project and Session labels aligned on one header row", () => {
    expect(sessionPaneSource).toContain('className="breadcrumb-project" title={projectLabel}');
    expect(sessionPaneSource).toContain('className="breadcrumb-separator" aria-hidden="true"');
    expect(rule(".breadcrumb")).toContain("flex: 0 1 auto");
    expect(rule(".breadcrumb")).toContain("overflow: hidden");
    expect(rule(".breadcrumb")).toContain("white-space: nowrap");
    expect(rule(".breadcrumb-project")).toContain("text-overflow: ellipsis");
    expect(rule(".breadcrumb-project")).toContain("white-space: nowrap");
    expect(rule(".breadcrumb strong")).toContain("text-overflow: ellipsis");
    expect(rule(".header-status")).toContain("flex: 0 0 auto");
    expect(styles).toMatch(/@container session-pane \(max-width: 640px\)[\s\S]*\.breadcrumb-project, \.breadcrumb-separator \{ display: none; \}/);
  });

  it("groups the empty Session state into icon, copy, and action spacing", () => {
    expect(appSource).toContain('className="no-selection-mark"');
    expect(appSource).toContain('className="no-selection-copy"');
    expect(rule(".no-selection-mark")).toContain("margin-bottom: 18px");
    expect(rule(".no-selection-copy")).toContain("gap: 7px");
    expect(rule(".no-selection .button")).toContain("margin-top: 22px");
  });

  it("keeps the global update action in the upper-left toolbar", () => {
    expect(sidebarSource).toMatch(/sidebar-top[\s\S]*notification-button[\s\S]*<SelfUpdateControl \/>[\s\S]*添加 Project[\s\S]*<\/div>/);
    expect(selfUpdateSource).toContain("self-update-trigger");
    expect(selfUpdateSource).toContain("shouldShowUpdateResultIndicator(status, presentationNow)");
    expect(selfUpdateSource.match(/showResult=\{showRecentResult\}/g)).toHaveLength(2);
    expect(selfUpdateSource).toContain('const triggerState = resultStateExpired ? "idle"');
    expect(rule(".self-update-trigger.running, .self-update-trigger.restarting")).toContain("color: var(--accent)");
  });

  it("gives the selected compact Side Chat tab a clear accent-soft surface", () => {
    expect(appSource).toContain('className="mobile-pane-tabs" role="group"');
    expect(appSource).toContain('aria-pressed={mobilePane === "main"} aria-controls="main-session-pane"');
    expect(appSource).toContain('aria-pressed={mobilePane === "side"} aria-controls="side-chat-pane"');
    expect(appSource).toContain('id="main-session-pane"');
    expect(appSource).toContain('id="side-chat-pane"');
    expect(styles).toMatch(/@container workspace \(max-width: 1100px\)[\s\S]*\.compact-workspace-header \{[^}]*background: var\(--bg\);/);
    expect(styles).toMatch(/@container workspace \(max-width: 1100px\)[\s\S]*\.mobile-pane-tabs button \{[^}]*background: transparent;[^}]*color: var\(--text-soft\);/);
    expect(styles).toMatch(/@container workspace \(max-width: 1100px\)[\s\S]*\.mobile-pane-tabs button\.active \{[^}]*background: var\(--accent-soft\);[^}]*color: color-mix\(in srgb, var\(--accent\) 72%, var\(--text\)\);/);
    expect(styles).toMatch(/@media \(max-width: 1100px\)[\s\S]*\.mobile-pane-tabs button\.active \{[^}]*background: var\(--accent-soft\);/);
    expect(styles).not.toMatch(/\.mobile-pane-tabs button\.active \{[^}]*box-shadow:/);
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

  it("keeps a multi-item submission queue bounded above the Composer", () => {
    expect(rule(".queued-submission-list")).toContain("max-height: min(220px, 30dvh)");
    expect(rule(".queued-submission-list")).toContain("overflow-y: auto");
    expect(rule(".queued-submission-heading")).toContain("position: sticky");
    expect(rule(".queued-command-banner")).not.toMatch(/\b(?:border|background):/);
    expect(composerSource).toContain('aria-label={`排队内容，共 ${queuedSubmissions.length} 项`}');
  });

  it("shows Fast as a compact accessible service-tier switch", () => {
    expect(serviceTierSource).toContain('tier.id === "priority"');
    expect(composerSource).toContain('role="switch" aria-checked={fastMode}');
    expect(composerSource).toContain('const next = fastMode ? null : fastServiceTier.id');
    expect(composerSource).toContain('effectiveSettings.current = { ...effectiveSettings.current, serviceTier: next }; setServiceTier(next)');
    expect(rule(".service-tier-toggle")).toContain("height: 27px");
    expect(rule(".service-tier-toggle.active")).toContain("color: var(--accent)");
    expect(styles).toMatch(/@container session-pane \(max-width: 640px\)[\s\S]*\.service-tier-toggle > span \{ display: none; \}/);
  });

  it("keeps the running controls visible before a Turn starts so sending cannot reflow the toolbar", () => {
    expect(composerSource).toContain('className={`composer-running-controls ${running ? "is-active" : "is-idle"}`}');
    expect(composerSource).not.toContain("aria-hidden={!running}");
    expect(composerSource).not.toContain('{running && <button type="button" className={`delivery-mode-toggle');
    expect(composerSource).toContain('disabled={!running}');
    expect(composerSource).toContain('"当前没有正在运行的 Turn"');
  });

  it("uses one primary button for sending and stopping", () => {
    expect(composerSource).toContain("const stopPrimaryAction = running && !hasPayload");
    expect(composerSource).toContain('className={stopPrimaryAction ? "stop-button" : "send-button"}');
    expect(composerSource).toContain("if (stopPrimaryAction) interrupt.mutate()");
    expect(composerSource).not.toMatch(/className="stop-button"/);
    expect(composerSource).not.toMatch(/className="send-button"/);
  });

  it("keeps the Composer toolbar on one line while its labels shrink to fit", () => {
    expect(rule(".composer-wrap")).toContain("max-width: 100%");
    expect(rule(".composer-wrap")).toContain("min-width: 0");
    expect(rule(".composer-toolbar")).toContain("display: flex");
    expect(rule(".composer-toolbar")).toContain("flex-wrap: nowrap");
    expect(rule(".composer-toolbar")).toContain("min-width: 0");
    expect(rule(".composer-toolbar")).toContain("overflow: hidden");
    expect(rule(".composer-controls")).toContain("min-width: 0");
    expect(rule(".composer-controls")).toContain("flex: 1 1 0");
    expect(rule(".composer-controls")).toContain("flex-wrap: nowrap");
    expect(rule(".composer-controls")).toContain("justify-content: flex-end");
    expect(rule(".composer-controls")).toContain("margin-left: auto");
    expect(rule(".composer-settings")).toContain("min-width: 0");
    expect(rule(".composer-settings")).toContain("justify-content: flex-end");
    expect(rule(".composer-settings")).toContain("overflow: hidden");
    expect(rule(".composer-actions")).toContain("flex: 0 0 auto");
    expect(rule(".access-control, .settings-select-trigger")).toContain("min-width: 0");
    expect(rule(".access-control > span, .settings-select-value")).toContain("min-width: 0");
    expect(rule(".access-control > span, .settings-select-value")).toContain("text-overflow: ellipsis");
    expect(rule(".access-control select")).toContain("position: absolute");
    expect(rule(".access-control select")).toContain("inset: 0");
    expect(rule(".access-control select")).toContain("width: 100%");
    expect(rule(".access-control select")).toContain("opacity: 0");
    expect(settingsSelectSource).not.toContain("CaretDown");
    expect(settingsSelectSource).toContain("DropdownMenu.RadioItem");
    expect(settingsSelectSource).toContain("settings-select-option-copy");
    expect(rule(".settings-select-option[data-state=\"checked\"]")).toContain("var(--accent)");
    expect(rule(".settings-select-menu")).toContain("max-width: calc(100vw - 16px)");
    expect(composerSource).toContain('<SettingsSelect className="model-select"');
    expect(composerSource).toContain('<SettingsSelect className="reasoning-select"');
    expect(composerSource).toMatch(/composer-toolbar[\s\S]*access-control[\s\S]*composer-controls[\s\S]*composer-settings[\s\S]*model-select[\s\S]*reasoning-select[\s\S]*composer-actions[\s\S]*composer-running-controls[\s\S]*send-button/);
    expect(rule(".send-button, .stop-button")).toContain("flex: 0 0 29px");
  });
});
