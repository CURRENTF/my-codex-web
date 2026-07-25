import type { Project, RuntimeState, SessionSummary } from "@codex-web/shared-types";

export function canBranchSession(projectAvailable: boolean, state: RuntimeState): boolean {
  return projectAvailable && state !== "disconnected";
}

export function recentSessionToAutoOpen(
  selectedThreadId: string | null,
  sessions: SessionSummary[],
  projects: Project[],
  preferredProjectId: string | null | undefined,
  suppressed = false,
): string | null {
  if (suppressed || selectedThreadId || sessions.length === 0) return null;
  const preferredProjectIsEmpty = !!preferredProjectId
    && projects.some((project) => project.id === preferredProjectId)
    && !sessions.some((session) => session.projectId === preferredProjectId);
  return preferredProjectIsEmpty ? null : sessions[0]!.threadId;
}

export function sessionCreationProjectId(
  explicitProjectId: string | undefined,
  selectedProjectId: string | undefined,
  preferredProjectId: string | null | undefined,
  projects: Project[],
): string | undefined {
  const available = projects.filter((project) => project.available);
  const isAvailable = (projectId: string | null | undefined) => !!projectId && available.some((project) => project.id === projectId);
  if (explicitProjectId) return isAvailable(explicitProjectId) ? explicitProjectId : undefined;
  const selected = isAvailable(selectedProjectId) ? selectedProjectId : undefined;
  const preferred = isAvailable(preferredProjectId) ? preferredProjectId ?? undefined : undefined;
  return selected ?? preferred ?? available[0]?.id;
}
