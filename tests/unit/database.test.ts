import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../apps/server/src/database";

const databases: Repositories[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("SQLite repositories", () => {
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
});
