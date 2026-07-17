import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireIsolatedCodexHome } from "../../scripts/isolated-codex-home";

describe("isolated Codex test home guard", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires an explicit non-default home", () => {
    expect(() => requireIsolatedCodexHome(undefined, "TEST_HOME")).toThrow("isolated test directory");
    expect(() => requireIsolatedCodexHome(path.join(homedir(), ".codex"), "TEST_HOME")).toThrow("normal Codex home");
    expect(requireIsolatedCodexHome(".runtime/codex-home/test", "TEST_HOME")).toBe(realpathSync.native(path.resolve(".runtime/codex-home/test")));
  });

  it("rejects symlinks and environment aliases to a normal Codex home", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-home-guard-"));
    const normal = path.join(root, "normal");
    const alias = path.join(root, "alias");
    mkdirSync(normal);
    symlinkSync(normal, alias);
    vi.stubEnv("CODEX_HOME", normal);

    expect(() => requireIsolatedCodexHome(alias, "TEST_HOME")).toThrow("normal Codex home");
  });
});
