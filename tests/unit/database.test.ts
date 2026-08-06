import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../apps/server/src/database";

const databases: Repositories[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("SQLite repositories", () => {
  it("adds latest-Turn setting columns to an existing project_sessions table", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-db-"));
    const databasePath = path.join(root, "app.db");
    const legacy = new Database(databasePath);
    legacy.exec(`CREATE TABLE project_sessions (
      thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cwd_snapshot TEXT,
      source_kind TEXT, origin TEXT NOT NULL, parent_thread_id TEXT, fork_turn_id TEXT,
      access_mode_override TEXT, added_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0
    )`);
    legacy.close();

    const repositories = new Repositories(databasePath); databases.push(repositories);
    const columns = repositories.db.prepare("PRAGMA table_info(project_sessions)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["last_model", "last_reasoning"]));
  });

  it("round-trips preferences and deletes only project mappings", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-db-"));
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    repositories.insertProject({ id: "p1", name: "Repo", rootPath: "/tmp/repo", canonicalPath: "/tmp/repo", orderIndex: 0, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess", createdAt: 1, lastOpenedAt: null, available: true });
    repositories.upsertProjectSession({ thread_id: "t1", project_id: "p1", cwd_snapshot: "/tmp/repo", source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null, added_at: 1, last_seen_at: 1 });
    expect(repositories.setPreferences({ sidebarMode: "projects", sideChatWidth: 51 }).sideChatWidth).toBe(51);
    repositories.deleteProject("p1");
    expect(repositories.getProject("p1")).toBeNull();
    expect(repositories.getProjectSession("t1")).toBeNull();
  });

  it("reports missing Project directories and preserves manual Session assignment", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-db-"));
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    repositories.insertProject({ id: "p1", name: "Available", rootPath: root, canonicalPath: root, orderIndex: 0, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess", createdAt: 1, lastOpenedAt: null, available: true });
    repositories.insertProject({ id: "p2", name: "Missing", rootPath: path.join(root, "missing"), canonicalPath: path.join(root, "missing"), orderIndex: 1, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess", createdAt: 1, lastOpenedAt: null, available: true });
    const file = path.join(root, "file.txt"); writeFileSync(file, "not a directory");
    repositories.insertProject({ id: "p3", name: "File", rootPath: file, canonicalPath: file, orderIndex: 2, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess", createdAt: 1, lastOpenedAt: null, available: true });
    repositories.upsertProjectSession({ thread_id: "t1", project_id: "p1", cwd_snapshot: root, source_kind: "cli", origin: "discovered", parent_thread_id: null, fork_turn_id: null, added_at: 1, last_seen_at: 1 });

    expect(repositories.getProject("p1")?.available).toBe(true);
    expect(repositories.getProject("p2")?.available).toBe(false);
    expect(repositories.getProject("p3")?.available).toBe(false);
    expect(repositories.moveProjectSession("t1", "p2")).toMatchObject({ project_id: "p2", origin: "manual" });

    repositories.upsertProjectSession({ thread_id: "t1", project_id: "p1", cwd_snapshot: root, source_kind: "cli", origin: "discovered", parent_thread_id: null, fork_turn_id: null, added_at: 2, last_seen_at: 2 });
    expect(repositories.getProjectSession("t1")).toMatchObject({ project_id: "p2", origin: "manual", last_seen_at: 2 });
  });

  it("persists a per-Session access override independently from the Project default", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-db-"));
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    repositories.insertProject({ id: "p1", name: "Repo", rootPath: root, canonicalPath: root, orderIndex: 0, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess", createdAt: 1, lastOpenedAt: null, available: true });
    repositories.upsertProjectSession({ thread_id: "t1", project_id: "p1", cwd_snapshot: root, source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null, added_at: 1, last_seen_at: 1 });

    expect(repositories.getProjectSession("t1")?.access_mode_override).toBeNull();
    expect(repositories.setSessionAccessModeOverride("t1", "readOnly").access_mode_override).toBe("readOnly");
    expect(repositories.getProject("p1")?.defaultAccessMode).toBe("fullAccess");
  });

  it("persists the model and reasoning used by the latest successful Turn", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-db-"));
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    repositories.insertProject({ id: "p1", name: "Repo", rootPath: root, canonicalPath: root, orderIndex: 0, defaultModel: "project-model", defaultReasoning: "high", defaultAccessMode: "fullAccess", createdAt: 1, lastOpenedAt: null, available: true });
    repositories.upsertProjectSession({ thread_id: "t1", project_id: "p1", cwd_snapshot: root, source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null, added_at: 1, last_seen_at: 1 });

    expect(repositories.getProjectSession("t1")).toMatchObject({ last_model: null, last_reasoning: null });
    expect(repositories.setSessionTurnSettings("t1", { model: "gpt-5.6-sol", reasoning: "max" })).toMatchObject({
      last_model: "gpt-5.6-sol",
      last_reasoning: "max",
    });
    expect(repositories.getProject("p1")).toMatchObject({ defaultModel: "project-model", defaultReasoning: "high" });
  });

  it("persists message Skill and attachment display metadata and removes it with the Session mapping", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-db-"));
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    repositories.insertProject({ id: "p1", name: "Repo", rootPath: root, canonicalPath: root, orderIndex: 0, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess", createdAt: 1, lastOpenedAt: null, available: true });
    repositories.upsertProjectSession({ thread_id: "t1", project_id: "p1", cwd_snapshot: root, source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null, added_at: 1, last_seen_at: 1 });

    repositories.setMessageSkillReferences("t1", "message-1", ["caveman", "caveman", "Academic Figure Prompt"]);
    expect(repositories.listMessageSkillReferences("t1")).toEqual([{
      client_user_message_id: "message-1",
      skill_names: ["caveman", "Academic Figure Prompt"],
    }]);
    repositories.setMessageAttachmentReferences("t1", "message-1", ["attachment-1", "attachment-1", "attachment-2"]);
    expect(repositories.listMessageAttachmentReferences("t1")).toEqual([{
      client_user_message_id: "message-1",
      attachment_ids: ["attachment-1", "attachment-2"],
    }]);

    repositories.removeProjectSession("t1");
    expect(repositories.listMessageSkillReferences("t1")).toEqual([]);
    expect(repositories.listMessageAttachmentReferences("t1")).toEqual([]);
  });
});
