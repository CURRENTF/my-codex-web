import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AccessMode, Preferences, Project } from "@codex-web/shared-types";

const DEFAULT_PREFERENCES: Preferences = {
  sidebarMode: "recent",
  sortDirection: "desc",
  sideChatWidth: 42,
  lastProjectId: null,
  lastThreadId: null,
  fullAccessNoticeSeen: false,
};

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  canonical_path: string;
  order_index: number;
  default_model: string | null;
  default_reasoning: string | null;
  default_access_mode: AccessMode;
  created_at: number;
  last_opened_at: number | null;
}

export interface ProjectSessionRow {
  thread_id: string;
  project_id: string;
  cwd_snapshot: string | null;
  source_kind: string | null;
  origin: "discovered" | "created" | "forked" | "manual";
  parent_thread_id: string | null;
  fork_turn_id: string | null;
  added_at: number;
  last_seen_at: number;
  hidden: number;
}

export class Repositories {
  readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void { this.db.close(); }

  listProjects(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY order_index ASC").all() as ProjectRow[];
    return rows.map((row) => this.projectFromRow(row));
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? this.projectFromRow(row) : null;
  }

  getProjectByCanonicalPath(canonicalPath: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE canonical_path = ?").get(canonicalPath) as ProjectRow | undefined;
    return row ? this.projectFromRow(row) : null;
  }

  insertProject(project: Project): void {
    this.db.prepare(`INSERT INTO projects (
      id, name, root_path, canonical_path, order_index, default_model,
      default_reasoning, default_access_mode, created_at, last_opened_at
    ) VALUES (@id, @name, @rootPath, @canonicalPath, @orderIndex, @defaultModel,
      @defaultReasoning, @defaultAccessMode, @createdAt, @lastOpenedAt)`).run(project);
  }

  updateProject(id: string, changes: Partial<Pick<Project, "name" | "orderIndex" | "defaultModel" | "defaultReasoning" | "defaultAccessMode" | "lastOpenedAt">>): Project {
    const entries = Object.entries(changes).filter(([, value]) => value !== undefined);
    const columns: Record<string, string> = {
      name: "name", orderIndex: "order_index", defaultModel: "default_model",
      defaultReasoning: "default_reasoning", defaultAccessMode: "default_access_mode", lastOpenedAt: "last_opened_at",
    };
    if (entries.length) {
      const set = entries.map(([key]) => `${columns[key]} = @${key}`).join(", ");
      this.db.prepare(`UPDATE projects SET ${set} WHERE id = @id`).run({ id, ...changes });
    }
    const project = this.getProject(id);
    if (!project) throw new Error("Project not found");
    return project;
  }

  deleteProject(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM project_sessions WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    })();
  }

  upsertProjectSession(row: Omit<ProjectSessionRow, "hidden"> & { hidden?: number }): void {
    this.db.prepare(`INSERT INTO project_sessions (
      thread_id, project_id, cwd_snapshot, source_kind, origin, parent_thread_id,
      fork_turn_id, added_at, last_seen_at, hidden
    ) VALUES (@thread_id, @project_id, @cwd_snapshot, @source_kind, @origin,
      @parent_thread_id, @fork_turn_id, @added_at, @last_seen_at, @hidden)
    ON CONFLICT(thread_id) DO UPDATE SET
      project_id=excluded.project_id,
      cwd_snapshot=excluded.cwd_snapshot,
      source_kind=excluded.source_kind,
      last_seen_at=excluded.last_seen_at,
      hidden=excluded.hidden,
      origin=CASE WHEN project_sessions.origin IN ('created','forked','manual') THEN project_sessions.origin ELSE excluded.origin END,
      parent_thread_id=COALESCE(project_sessions.parent_thread_id, excluded.parent_thread_id),
      fork_turn_id=COALESCE(project_sessions.fork_turn_id, excluded.fork_turn_id)`).run({ hidden: 0, ...row });
  }

  listProjectSessions(projectId?: string): ProjectSessionRow[] {
    const sql = projectId
      ? "SELECT * FROM project_sessions WHERE hidden = 0 AND project_id = ?"
      : "SELECT * FROM project_sessions WHERE hidden = 0";
    return (projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all()) as ProjectSessionRow[];
  }

  getProjectSession(threadId: string): ProjectSessionRow | null {
    return (this.db.prepare("SELECT * FROM project_sessions WHERE thread_id = ?").get(threadId) as ProjectSessionRow | undefined) ?? null;
  }

  removeProjectSession(threadId: string): void {
    this.db.prepare("DELETE FROM project_sessions WHERE thread_id = ?").run(threadId);
  }

  getPreferences(): Preferences {
    const result = { ...DEFAULT_PREFERENCES } as Record<string, unknown>;
    const rows = this.db.prepare("SELECT key, value_json FROM preferences").all() as Array<{ key: string; value_json: string }>;
    for (const row of rows) {
      if (row.key in result) result[row.key] = JSON.parse(row.value_json) as unknown;
    }
    return result as unknown as Preferences;
  }

  setPreferences(changes: Partial<Preferences>): Preferences {
    const statement = this.db.prepare(`INSERT INTO preferences (key, value_json) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`);
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(changes)) statement.run(key, JSON.stringify(value));
    })();
    return this.getPreferences();
  }

  markThreadTerminal(threadId: string, status: string, completedAt: number): void {
    this.db.prepare(`INSERT INTO thread_ui_state (thread_id, last_completed_at, last_terminal_status)
      VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET
      last_completed_at=excluded.last_completed_at, last_terminal_status=excluded.last_terminal_status`).run(threadId, completedAt, status);
  }

  markThreadViewed(threadId: string): void {
    this.db.prepare(`INSERT INTO thread_ui_state (thread_id, last_viewed_at) VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET last_viewed_at=excluded.last_viewed_at`).run(threadId, Date.now());
  }

  private projectFromRow(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      canonicalPath: row.canonical_path,
      orderIndex: row.order_index,
      defaultModel: row.default_model,
      defaultReasoning: row.default_reasoning,
      defaultAccessMode: row.default_access_mode,
      createdAt: row.created_at,
      lastOpenedAt: row.last_opened_at,
      available: true,
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE, order_index INTEGER NOT NULL,
        default_model TEXT, default_reasoning TEXT,
        default_access_mode TEXT NOT NULL DEFAULT 'fullAccess',
        created_at INTEGER NOT NULL, last_opened_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS project_sessions (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cwd_snapshot TEXT,
        source_kind TEXT, origin TEXT NOT NULL, parent_thread_id TEXT, fork_turn_id TEXT,
        added_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS thread_ui_state (
        thread_id TEXT PRIMARY KEY, last_completed_at INTEGER,
        last_terminal_status TEXT, last_viewed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    `);
  }
}
