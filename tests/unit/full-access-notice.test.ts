import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldShowFullAccessNotice } from "../../apps/web/src/full-access-notice";

const appSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/App.tsx", import.meta.url)), "utf8");
const sessionPaneSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/components/SessionPane.tsx", import.meta.url)), "utf8");

describe("Full Access notice", () => {
  it("appears as soon as the Composer selects Full Access", () => {
    expect(shouldShowFullAccessNotice("readOnly", "fullAccess", false)).toBe(true);
    expect(shouldShowFullAccessNotice("workspaceWrite", "fullAccess", false)).toBe(true);
  });

  it("is shown only once per Project", () => {
    expect(shouldShowFullAccessNotice("fullAccess", null, false)).toBe(true);
    expect(shouldShowFullAccessNotice("fullAccess", null, true)).toBe(false);
  });

  it("shares the Project-level acknowledgement with the main and Side Chat panes", () => {
    expect(sessionPaneSource).not.toContain("!sideChat && shouldShowFullAccessNotice");
    expect(sessionPaneSource).toContain("onAccessModeChange={setComposerAccessMode}");
    expect(appSource.match(/fullAccessNoticeSeen=\{fullAccessNoticeSeen\}/g)).toHaveLength(2);
    expect(appSource.match(/onAcknowledgeFullAccess=\{acknowledgeFullAccess\}/g)).toHaveLength(2);
  });
});
