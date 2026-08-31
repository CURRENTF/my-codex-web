export const MINIMUM_CODEX_CLI_VERSION = "0.149.0";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value.match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareCore(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function codexCliVersionFromUserAgent(userAgent: string): string | null {
  const parsed = parseVersion(userAgent);
  if (!parsed) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ""}`;
}

export function isSupportedCodexCliVersion(version: string): boolean {
  const installed = parseVersion(version);
  const minimum = parseVersion(MINIMUM_CODEX_CLI_VERSION);
  if (!installed || !minimum) return false;
  const coreComparison = compareCore(installed, minimum);
  if (coreComparison !== 0) return coreComparison > 0;
  return installed.prerelease === null;
}

export function requireSupportedCodexCli(userAgent: string): string {
  const version = codexCliVersionFromUserAgent(userAgent);
  if (!version) {
    throw new Error(`Unable to determine the Codex CLI version from App Server user agent; my-codex-web requires ${MINIMUM_CODEX_CLI_VERSION} or newer`);
  }
  if (!isSupportedCodexCliVersion(version)) {
    throw new Error(`Unsupported Codex CLI ${version}; my-codex-web requires ${MINIMUM_CODEX_CLI_VERSION} or newer`);
  }
  return version;
}
