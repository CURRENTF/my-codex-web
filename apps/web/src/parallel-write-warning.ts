import type { AccessMode, RuntimeState } from "@codex-web/shared-types";

const activeStates = new Set<RuntimeState>(["running", "waitingForInput"]);

export function shouldWarnAboutParallelFullAccess(
  main: { state: RuntimeState; accessMode: AccessMode } | null | undefined,
  side: { state: RuntimeState; accessMode: AccessMode } | null | undefined,
): boolean {
  return !!main && !!side
    && main.accessMode === "fullAccess"
    && side.accessMode === "fullAccess"
    && activeStates.has(main.state)
    && activeStates.has(side.state);
}
