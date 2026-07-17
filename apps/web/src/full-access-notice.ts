import type { AccessMode } from "@codex-web/shared-types";

export function shouldShowFullAccessNotice(
  persistedAccessMode: AccessMode,
  composerAccessMode: AccessMode | null,
  noticeSeen: boolean,
): boolean {
  return !noticeSeen && (composerAccessMode ?? persistedAccessMode) === "fullAccess";
}
