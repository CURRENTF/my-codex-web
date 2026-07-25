import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { refreshProjectAvailability, refreshProjectAvailabilityAfterError } from "../../apps/web/src/project-refresh";

describe("Project availability refresh", () => {
  it("refreshes both Project availability and Session discovery after a rescan", async () => {
    const invalidate = vi.fn(async () => undefined);

    await refreshProjectAvailability(invalidate);

    expect(invalidate.mock.calls).toEqual([
      [["projects"]],
      [["sessions"]],
    ]);
  });

  it("refreshes stale Project state after a project_unavailable mutation failure", async () => {
    const invalidate = vi.fn(async () => undefined);

    await expect(refreshProjectAvailabilityAfterError(
      { body: { error: "project_unavailable" } },
      invalidate,
    )).resolves.toBe(true);
    await expect(refreshProjectAvailabilityAfterError(
      { body: { error: "other" } },
      invalidate,
    )).resolves.toBe(false);

    expect(invalidate.mock.calls).toEqual([
      [["projects"]],
      [["sessions"]],
    ]);
  });

  it("applies unavailable-Project refresh handling to Session creation, Fork, and Side Chat", () => {
    const appSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/App.tsx", import.meta.url)), "utf8");
    const sessionPaneSource = readFileSync(fileURLToPath(new URL("../../apps/web/src/components/SessionPane.tsx", import.meta.url)), "utf8");

    expect(appSource).toContain("refreshProjectAvailabilityAfterError");
    expect(sessionPaneSource.match(/refreshProjectAvailabilityAfterError/g)).toHaveLength(3);
  });
});
