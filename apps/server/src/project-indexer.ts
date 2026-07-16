import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Project } from "@codex-web/shared-types";
import type { CodexAdapter } from "@codex-web/codex-adapter";
import { Repositories } from "./database.js";

function sourceKind(source: unknown): string {
  if (typeof source === "string") return source;
  if (source && typeof source === "object" && "custom" in source) return String((source as { custom: unknown }).custom);
  return "unknown";
}

export function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function longestProjectMatch(cwd: string, projects: Project[]): Project | null {
  return projects
    .filter((project) => isPathInside(cwd, project.canonicalPath))
    .sort((left, right) => right.canonicalPath.length - left.canonicalPath.length)[0] ?? null;
}

export class ProjectIndexer {
  private scanning: Promise<void> | null = null;

  constructor(private readonly repositories: Repositories, private readonly adapter: CodexAdapter) {}

  async addProject(rootPath: string, displayName?: string): Promise<Project> {
    await access(rootPath);
    const canonicalPath = await realpath(rootPath);
    const existing = this.repositories.getProjectByCanonicalPath(canonicalPath);
    if (existing) return existing;
    const projects = this.repositories.listProjects();
    const project: Project = {
      id: randomUUID(),
      name: displayName?.trim() || path.basename(canonicalPath),
      rootPath,
      canonicalPath,
      orderIndex: projects.length,
      defaultModel: null,
      defaultReasoning: null,
      defaultAccessMode: "fullAccess",
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
      available: true,
    };
    this.repositories.insertProject(project);
    await this.scanRoot(project);
    void this.scanAll();
    return project;
  }

  async scanRoot(project: Project): Promise<void> {
    const response = await this.adapter.listSessions({ cwd: project.canonicalPath, limit: 100 });
    const now = Date.now();
    for (const thread of response.data) {
      this.repositories.upsertProjectSession({
        thread_id: thread.id,
        project_id: project.id,
        cwd_snapshot: thread.cwd,
        source_kind: sourceKind(thread.source),
        origin: "discovered",
        parent_thread_id: thread.forkedFromId,
        fork_turn_id: null,
        added_at: now,
        last_seen_at: now,
      });
    }
  }

  async scanAll(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.performScanAll().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async performScanAll(): Promise<void> {
    const projects = await Promise.all(this.repositories.listProjects().map(async (project) => ({
      ...project,
      canonicalPath: await realpath(project.canonicalPath).catch(() => project.canonicalPath),
    })));
    let cursor: string | null = null;
    const now = Date.now();
    do {
      const response = await this.adapter.listSessions({ cursor, limit: 100 });
      for (const thread of response.data) {
        const canonicalCwd = await realpath(thread.cwd).catch(() => thread.cwd);
        const project = longestProjectMatch(canonicalCwd, projects);
        if (!project) continue;
        const existing = this.repositories.getProjectSession(thread.id);
        this.repositories.upsertProjectSession({
          thread_id: thread.id,
          project_id: existing?.origin === "manual" ? existing.project_id : project.id,
          cwd_snapshot: canonicalCwd,
          source_kind: sourceKind(thread.source),
          origin: existing?.origin ?? "discovered",
          parent_thread_id: existing?.parent_thread_id ?? thread.forkedFromId,
          fork_turn_id: existing?.fork_turn_id ?? null,
          added_at: existing?.added_at ?? now,
          last_seen_at: now,
        });
      }
      cursor = response.nextCursor;
    } while (cursor);
  }
}
