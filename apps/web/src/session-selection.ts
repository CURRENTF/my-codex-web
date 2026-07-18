import type { Project, SessionSummary } from "@codex-web/shared-types";

export function recentSessionToAutoOpen(
  selectedThreadId: string | null,
  sessions: SessionSummary[],
  projects: Project[],
  preferredProjectId: string | null | undefined,
): string | null {
  if (selectedThreadId || sessions.length === 0) return null;
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
  const preferred = projects.some((project) => project.id === preferredProjectId) ? preferredProjectId ?? undefined : undefined;
  return explicitProjectId ?? selectedProjectId ?? preferred ?? projects[0]?.id;
}
