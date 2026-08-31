import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { setupSteps, supportsNodeVersion } from "../../scripts/setup.mjs";

describe("one-command setup", () => {
  it("installs the locked development dependencies before building and linking", () => {
    expect(packageJson.scripts.setup).toBe("node scripts/setup.mjs");
    expect(setupSteps.map((step) => step.args)).toEqual([
      ["ci", "--include=dev", "--no-audit", "--no-fund"],
      ["run", "build"],
      ["link", "--no-audit", "--no-fund"],
    ]);
  });

  it("enforces the repository Node.js floor", () => {
    expect(supportsNodeVersion("v22.21.0")).toBe(false);
    expect(supportsNodeVersion("v22.22.0")).toBe(true);
    expect(supportsNodeVersion("v24.0.0")).toBe(true);
  });
});
