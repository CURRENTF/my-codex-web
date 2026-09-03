import Database from "better-sqlite3";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { AccessMode, Preferences, Project } from "@codex-web/shared-types";

const DEFAULT_PREFERENCES: Preferences = {
  sidebarMode: "recent",
  sortDirection: "desc",
  sideChatWidth: 42,
  lastProjectId: null,
  lastThreadId: null,
  fullAccessNoticeSeenProjects: [],
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
  access_mode_override: AccessMode | null;
  last_model: string | null;
  last_reasoning: string | null;
  last_service_tier: string | null;
  has_last_service_tier: number;
  summary_title: string | null;
  summary_preview: string | null;
  summary_created_at: number | null;
  summary_updated_at: number | null;
  added_at: number;
  last_seen_at: number;
  hidden: number;
  pinned: number;
}

export interface ThreadUiStateRow {
  thread_id: string;
  last_completed_at: number | null;
  last_terminal_status: string | null;
  last_viewed_at: number | null;
}

export interface MessageSkillReferenceRow {
  client_user_message_id: string;
  skill_names: string[];
}

export interface MessageAttachmentReferenceRow {
  client_user_message_id: string;
  attachment_ids: string[];
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
      this.db.prepare("DELETE FROM thread_ui_state WHERE thread_id IN (SELECT thread_id FROM project_sessions WHERE project_id = ?)").run(id);
      this.db.prepare("DELETE FROM project_sessions WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    })();
  }

  upsertProjectSession(row: Omit<ProjectSessionRow,
    "hidden" | "access_mode_override" | "last_model" | "last_reasoning" | "last_service_tier" | "has_last_service_tier"
    | "summary_title" | "summary_preview" | "summary_created_at" | "summary_updated_at" | "pinned"
  > & Partial<Pick<ProjectSessionRow, "summary_title" | "summary_preview" | "summary_created_at" | "summary_updated_at">> & { hidden?: number }): void {
    this.db.prepare(`INSERT INTO project_sessions (
      thread_id, project_id, cwd_snapshot, source_kind, origin, parent_thread_id,
      fork_turn_id, summary_title, summary_preview, summary_created_at,
      summary_updated_at, added_at, last_seen_at, hidden
    ) VALUES (@thread_id, @project_id, @cwd_snapshot, @source_kind, @origin,
      @parent_thread_id, @fork_turn_id, @summary_title, @summary_preview,
      @summary_created_at, @summary_updated_at, @added_at, @last_seen_at, @hidden)
    ON CONFLICT(thread_id) DO UPDATE SET
      project_id=CASE WHEN project_sessions.origin = 'manual' THEN project_sessions.project_id ELSE excluded.project_id END,
      cwd_snapshot=excluded.cwd_snapshot,
      source_kind=excluded.source_kind,
      last_seen_at=excluded.last_seen_at,
      hidden=excluded.hidden,
      summary_title=COALESCE(excluded.summary_title, project_sessions.summary_title),
      summary_preview=COALESCE(excluded.summary_preview, project_sessions.summary_preview),
      summary_created_at=COALESCE(excluded.summary_created_at, project_sessions.summary_created_at),
      summary_updated_at=COALESCE(excluded.summary_updated_at, project_sessions.summary_updated_at),
      origin=CASE WHEN project_sessions.origin IN ('created','forked','manual') THEN project_sessions.origin ELSE excluded.origin END,
      parent_thread_id=COALESCE(project_sessions.parent_thread_id, excluded.parent_thread_id),
      fork_turn_id=COALESCE(project_sessions.fork_turn_id, excluded.fork_turn_id)`).run({
        hidden: 0,
        summary_title: null,
        summary_preview: null,
        summary_created_at: null,
        summary_updated_at: null,
        ...row,
      });
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
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM thread_ui_state WHERE thread_id = ?").run(threadId);
      this.db.prepare("DELETE FROM project_sessions WHERE thread_id = ?").run(threadId);
    })();
  }

  moveProjectSession(threadId: string, projectId: string): ProjectSessionRow {
    const result = this.db.prepare("UPDATE project_sessions SET project_id = ?, origin = 'manual' WHERE thread_id = ?").run(projectId, threadId);
    if (!result.changes) throw new Error("Session mapping not found");
    const mapping = this.getProjectSession(threadId);
    if (!mapping) throw new Error("Session mapping not found");
    return mapping;
  }

  setSessionAccessModeOverride(threadId: string, accessMode: AccessMode): ProjectSessionRow {
    const result = this.db.prepare("UPDATE project_sessions SET access_mode_override = ? WHERE thread_id = ?").run(accessMode, threadId);
    if (!result.changes) throw new Error("Session mapping not found");
    const mapping = this.getProjectSession(threadId);
    if (!mapping) throw new Error("Session mapping not found");
    return mapping;
  }

  setSessionTurnSettings(threadId: string, settings: { model: string | null; reasoning: string | null; serviceTier: string | null }): ProjectSessionRow {
    const result = this.db.prepare("UPDATE project_sessions SET last_model = ?, last_reasoning = ?, last_service_tier = ?, has_last_service_tier = 1 WHERE thread_id = ?")
      .run(settings.model, settings.reasoning, settings.serviceTier, threadId);
    if (!result.changes) throw new Error("Session mapping not found");
    const mapping = this.getProjectSession(threadId);
    if (!mapping) throw new Error("Session mapping not found");
    return mapping;
  }

  setSessionSummary(threadId: string, summary: { title: string; preview: string; createdAt: number; updatedAt: number }): void {
    this.db.prepare(`UPDATE project_sessions SET
      summary_title = ?, summary_preview = ?, summary_created_at = ?, summary_updated_at = ?
      WHERE thread_id = ?`).run(summary.title, summary.preview, summary.createdAt, summary.updatedAt, threadId);
  }

  setSessionPinned(threadId: string, pinned: boolean): ProjectSessionRow {
    const result = this.db.prepare("UPDATE project_sessions SET pinned = ? WHERE thread_id = ?").run(pinned ? 1 : 0, threadId);
    if (!result.changes) throw new Error("Session mapping not found");
    const mapping = this.getProjectSession(threadId);
    if (!mapping) throw new Error("Session mapping not found");
    return mapping;
  }

  setMessageSkillReferences(threadId: string, clientUserMessageId: string, skillNames: readonly string[]): void {
    const uniqueNames = [...new Set(skillNames.map((name) => name.trim()).filter(Boolean))];
    if (!uniqueNames.length) {
      this.removeMessageSkillReferences(threadId, clientUserMessageId);
      return;
    }
    this.db.prepare(`INSERT INTO message_skill_refs (
      thread_id, client_user_message_id, skill_names_json, created_at
    ) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, client_user_message_id) DO UPDATE SET
      skill_names_json=excluded.skill_names_json`).run(threadId, clientUserMessageId, JSON.stringify(uniqueNames), Date.now());
  }

  listMessageSkillReferences(threadId: string): MessageSkillReferenceRow[] {
    const rows = this.db.prepare(`SELECT client_user_message_id, skill_names_json
      FROM message_skill_refs WHERE thread_id = ? ORDER BY created_at ASC`).all(threadId) as Array<{ client_user_message_id: string; skill_names_json: string }>;
    return rows.flatMap((row) => {
      try {
        const parsed = JSON.parse(row.skill_names_json) as unknown;
        if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === "string")) return [];
        return [{ client_user_message_id: row.client_user_message_id, skill_names: parsed }];
      } catch {
        return [];
      }
    });
  }

  removeMessageSkillReferences(threadId: string, clientUserMessageId: string): void {
    this.db.prepare("DELETE FROM message_skill_refs WHERE thread_id = ? AND client_user_message_id = ?").run(threadId, clientUserMessageId);
  }

  setMessageAttachmentReferences(threadId: string, clientUserMessageId: string, attachmentIds: readonly string[]): void {
    const uniqueIds = [...new Set(attachmentIds.filter(Boolean))];
    if (!uniqueIds.length) {
      this.removeMessageAttachmentReferences(threadId, clientUserMessageId);
      return;
    }
    this.db.prepare(`INSERT INTO message_attachment_refs (
      thread_id, client_user_message_id, attachment_ids_json, created_at
    ) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, client_user_message_id) DO UPDATE SET
      attachment_ids_json=excluded.attachment_ids_json`).run(threadId, clientUserMessageId, JSON.stringify(uniqueIds), Date.now());
  }

  listMessageAttachmentReferences(threadId: string): MessageAttachmentReferenceRow[] {
    const rows = this.db.prepare(`SELECT client_user_message_id, attachment_ids_json
      FROM message_attachment_refs WHERE thread_id = ? ORDER BY created_at ASC`).all(threadId) as Array<{ client_user_message_id: string; attachment_ids_json: string }>;
    return rows.flatMap((row) => {
      try {
        const parsed = JSON.parse(row.attachment_ids_json) as unknown;
        if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) return [];
        return [{ client_user_message_id: row.client_user_message_id, attachment_ids: parsed }];
      } catch {
        return [];
      }
    });
  }

  removeMessageAttachmentReferences(threadId: string, clientUserMessageId: string): void {
    this.db.prepare("DELETE FROM message_attachment_refs WHERE thread_id = ? AND client_user_message_id = ?").run(threadId, clientUserMessageId);
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

  clearThreadTerminal(threadId: string): void {
    this.db.prepare("DELETE FROM thread_ui_state WHERE thread_id = ?").run(threadId);
  }

  listThreadUiStates(): ThreadUiStateRow[] {
    return this.db.prepare(`SELECT state.* FROM thread_ui_state state
      INNER JOIN project_sessions sessions ON sessions.thread_id = state.thread_id
      WHERE sessions.hidden = 0`).all() as ThreadUiStateRow[];
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
      available: (() => { try { return statSync(row.canonical_path).isDirectory(); } catch { return false; } })(),
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
        access_mode_override TEXT CHECK (access_mode_override IN ('fullAccess', 'workspaceWrite', 'readOnly')),
        last_model TEXT, last_reasoning TEXT, last_service_tier TEXT,
        has_last_service_tier INTEGER NOT NULL DEFAULT 0 CHECK (has_last_service_tier IN (0, 1)),
        summary_title TEXT, summary_preview TEXT,
        summary_created_at INTEGER, summary_updated_at INTEGER,
        added_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS thread_ui_state (
        thread_id TEXT PRIMARY KEY, last_completed_at INTEGER,
        last_terminal_status TEXT, last_viewed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS message_skill_refs (
        thread_id TEXT NOT NULL, client_user_message_id TEXT NOT NULL,
        skill_names_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, client_user_message_id),
        FOREIGN KEY(thread_id) REFERENCES project_sessions(thread_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS message_attachment_refs (
        thread_id TEXT NOT NULL, client_user_message_id TEXT NOT NULL,
        attachment_ids_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, client_user_message_id),
        FOREIGN KEY(thread_id) REFERENCES project_sessions(thread_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    `);
    const projectSessionColumns = this.db.prepare("PRAGMA table_info(project_sessions)").all() as Array<{ name: string }>;
    if (!projectSessionColumns.some((column) => column.name === "access_mode_override")) {
      this.db.exec("ALTER TABLE project_sessions ADD COLUMN access_mode_override TEXT CHECK (access_mode_override IN ('fullAccess', 'workspaceWrite', 'readOnly'))");
    }
    if (!projectSessionColumns.some((column) => column.name === "last_model")) {
      this.db.exec("ALTER TABLE project_sessions ADD COLUMN last_model TEXT");
    }
    if (!projectSessionColumns.some((column) => column.name === "last_reasoning")) {
      this.db.exec("ALTER TABLE project_sessions ADD COLUMN last_reasoning TEXT");
    }
    if (!projectSessionColumns.some((column) => column.name === "last_service_tier")) {
      this.db.exec("ALTER TABLE project_sessions ADD COLUMN last_service_tier TEXT");
    }
    if (!projectSessionColumns.some((column) => column.name === "has_last_service_tier")) {
      this.db.exec("ALTER TABLE project_sessions ADD COLUMN has_last_service_tier INTEGER NOT NULL DEFAULT 0 CHECK (has_last_service_tier IN (0, 1))");
    }
    if (!projectSessionColumns.some((column) => column.name === "summary_title")) {
      this.db.exec("ALTER TABLE project_sessions ADD COLUMN summary_title TEXT");
    }
    if (!projectSessionColumns.some((column) => column.name === "summary_preview")) {
      this.db.exec("ALTER TABLE project_sessions ADD COLUMN summary_preview TEXT");
    }
    if (!projectSessionColumns.some((column) => column.name === "summary_created_at")) {
      this.db.exec("ALTER TABLE project_sessions ADD COLUMN summary_created_at INTEGER");
    }
    if (!projectSessionColumns.some((column) => column.name === "summary_updated_at")) {
      this.db.exec("ALTER TABLE project_sessions ADD COLUMN summary_updated_at INTEGER");
    }
    if (!projectSessionColumns.some((column) => column.name === "pinned")) {
      this.db.exec("ALTER TABLE project_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))");
    }
  }
}
