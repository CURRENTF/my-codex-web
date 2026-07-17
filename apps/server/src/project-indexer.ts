import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Project } from "@codex-web/shared-types";
import type { CodexAdapter } from "@codex-web/codex-adapter";
import { Repositories } from "./database.js";

export function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function longestProjectMatch(cwd: string, projects: Project[]): Project | null {
  return projects
    .filter((project) => isPathInside(cwd, project.canonicalPath))
    .sort((left, right) => right.canonicalPath.length - left.canonicalPath.length)[0] ?? null;
}

export class ProjectIndexer extends EventEmitter {
  private scanning: Promise<void> | null = null;
  private scanAgain = false;

  constructor(private readonly repositories: Repositories, private readonly adapter: CodexAdapter) { super(); }

  async addProject(rootPath: string, displayName?: string): Promise<Project> {
    if (!path.isAbsolute(rootPath)) throw new Error("Project path must be absolute");
    if (!(await stat(rootPath)).isDirectory()) throw new Error("Project path must be a directory");
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
    const now = Date.now();
    let cursor: string | null = null;
    do {
      const response = await this.adapter.listSessions({ cwd: project.canonicalPath, cursor, limit: 100 });
      for (const thread of response.data) {
        this.repositories.upsertProjectSession({
          thread_id: thread.id,
          project_id: project.id,
          cwd_snapshot: thread.cwd,
          source_kind: thread.sourceKind,
          origin: "discovered",
          parent_thread_id: thread.forkedFromId,
          fork_turn_id: null,
          added_at: now,
          last_seen_at: now,
        });
      }
      cursor = response.nextCursor;
    } while (cursor);
  }

  async scanStartupRoots(): Promise<void> {
    const projects = this.repositories.listProjects().filter((project) => project.available);
    await Promise.all(projects.map((project) => this.scanRoot(project)));
  }

  async scanAll(): Promise<void> {
    if (this.scanning) {
      this.scanAgain = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      do {
        this.scanAgain = false;
        await this.performScanAll();
        this.emit("scanComplete");
      } while (this.scanAgain);
    })().finally(() => { this.scanning = null; });
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
          source_kind: thread.sourceKind,
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
