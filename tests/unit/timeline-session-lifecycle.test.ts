import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sessionPane = readFileSync(
  fileURLToPath(new URL("../../apps/web/src/components/SessionPane.tsx", import.meta.url)),
  "utf8",
);

describe("Timeline Session lifecycle", () => {
  it("remounts Timeline when the selected Session changes", () => {
    expect(sessionPane).toContain("<Timeline key={threadId}");
  });

  it("uses the shared Project and connection guard for every Fork and Side Chat surface", () => {
    expect(sessionPane).toContain("branchActionsAvailable = canBranchSession(project.available, state)");
    expect(sessionPane).toContain("side.isPending || !branchActionsAvailable");
    expect(sessionPane).toContain("canFork={!sideChat && branchActionsAvailable}");
    expect(sessionPane).toContain("!pendingFork || !branchActionsAvailable");
  });
});
