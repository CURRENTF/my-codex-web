import { describe, expect, it } from "vitest";
import { codexCliVersionFromUserAgent, isSupportedCodexCliVersion, MINIMUM_CODEX_CLI_VERSION, requireSupportedCodexCli } from "@codex-web/codex-adapter";

describe("Codex CLI compatibility", () => {
  it("extracts the App Server CLI version from the initialize user agent", () => {
    expect(codexCliVersionFromUserAgent("Codex Desktop/0.149.1 (Linux; x86_64) dumb (codex-web; 0.1.0)")).toBe("0.149.1");
    expect(codexCliVersionFromUserAgent("codex_cli_rs/0.150.0-alpha.2 (Linux 6.8; x86_64)")).toBe("0.150.0-alpha.2");
    expect(codexCliVersionFromUserAgent("unversioned-app-server")).toBeNull();
  });

  it("enforces the declared minimum without accepting its prereleases", () => {
    expect(MINIMUM_CODEX_CLI_VERSION).toBe("0.149.0");
    expect(isSupportedCodexCliVersion("0.148.9")).toBe(false);
    expect(isSupportedCodexCliVersion("0.149.0-alpha.9")).toBe(false);
    expect(isSupportedCodexCliVersion("0.149.0")).toBe(true);
    expect(isSupportedCodexCliVersion("0.149.1")).toBe(true);
    expect(isSupportedCodexCliVersion("0.150.0-alpha.1")).toBe(true);
  });

  it("returns the supported version and gives actionable errors otherwise", () => {
    expect(requireSupportedCodexCli("Codex Desktop/0.149.1 (Linux; x86_64)")).toBe("0.149.1");
    expect(() => requireSupportedCodexCli("Codex Desktop/0.147.0 (Linux; x86_64)")).toThrow("requires 0.149.0 or newer");
    expect(() => requireSupportedCodexCli("unknown")).toThrow("Unable to determine the Codex CLI version");
  });
});
