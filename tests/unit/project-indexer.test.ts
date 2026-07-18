import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@codex-web/shared-types";
import type { CodexAdapter } from "@codex-web/codex-adapter";
import { Repositories } from "../../apps/server/src/database";
import { isPathInside, longestProjectMatch, ProjectIndexer } from "../../apps/server/src/project-indexer";

const databases: Repositories[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function project(id: string, canonicalPath: string): Project {
  return { id, name: id, rootPath: canonicalPath, canonicalPath, orderIndex: 0, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess", createdAt: 1, lastOpenedAt: null, available: true };
}

describe("ProjectIndexer path matching", () => {
  it("does not confuse sibling prefixes", () => {
    expect(isPathInside("/work/repository", "/work/repo")).toBe(false);
    expect(isPathInside("/work/repo/packages", "/work/repo")).toBe(true);
  });

  it("assigns nested cwd to the longest matching project", () => {
    const projects = [project("root", "/work/repo"), project("api", "/work/repo/packages/api")];
    expect(longestProjectMatch("/work/repo/packages/api/src", projects)?.id).toBe("api");
    expect(longestProjectMatch("/work/repo/packages/web", projects)?.id).toBe("root");
  });

  it("rejects relative Project paths before invoking the App Server", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-indexer-"));
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    const listSessions = vi.fn();
    const indexer = new ProjectIndexer(repositories, { listSessions } as unknown as CodexAdapter);

    await expect(indexer.addProject("relative/path")).rejects.toThrow("absolute");
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("rejects an absolute file path instead of storing it as a Project", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-indexer-"));
    const file = path.join(root, "not-a-directory.txt"); writeFileSync(file, "test");
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    const listSessions = vi.fn();
    const indexer = new ProjectIndexer(repositories, { listSessions } as unknown as CodexAdapter);

    await expect(indexer.addProject(file)).rejects.toThrow("directory");
    expect(repositories.listProjects()).toHaveLength(0);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("rolls back a newly inserted Project when its required exact-root scan fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-indexer-"));
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    const listSessions = vi.fn()
      .mockRejectedValueOnce(new Error("app-server disconnected"))
      .mockResolvedValue({ data: [], nextCursor: null });
    const indexer = new ProjectIndexer(repositories, { listSessions } as unknown as CodexAdapter);

    await expect(indexer.addProject(root)).rejects.toThrow("app-server disconnected");
    expect(repositories.listProjects()).toEqual([]);

    const backgroundComplete = new Promise<void>((resolve) => indexer.once("scanComplete", () => resolve()));
    await expect(indexer.addProject(root)).resolves.toMatchObject({ rootPath: root });
    await backgroundComplete;
    expect(listSessions).toHaveBeenCalledTimes(3);
  });

  it("reports background scan failures without leaving an unhandled rejection", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-indexer-"));
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    repositories.insertProject(project("root", root));
    const indexer = new ProjectIndexer(repositories, { listSessions: vi.fn(async () => { throw new Error("temporary scan failure"); }) } as unknown as CodexAdapter);
    const failure = vi.fn(); indexer.on("scanError", failure);

    indexer.scanAllInBackground();

    await vi.waitFor(() => expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: "temporary scan failure" })));
  });

  it("paginates the immediate exact-root scan", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-indexer-"));
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    const target = project("project", root);
    repositories.insertProject(target);
    const listSessions = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: "t1", cwd: root, sourceKind: "cli", forkedFromId: null }], nextCursor: "next" })
      .mockResolvedValueOnce({ data: [{ id: "t2", cwd: root, sourceKind: "appServer", forkedFromId: null }], nextCursor: null });
    const indexer = new ProjectIndexer(repositories, { listSessions } as unknown as CodexAdapter);

    await indexer.scanRoot(target);

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(repositories.listProjectSessions().map((mapping) => mapping.thread_id).sort()).toEqual(["t1", "t2"]);
  });

  it("runs exact-root discovery for every available Project during startup", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-indexer-"));
    const nested = path.join(root, "nested"); mkdirSync(nested);
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    repositories.insertProject(project("root", root));
    repositories.insertProject({ ...project("nested", nested), orderIndex: 1 });
    const listSessions = vi.fn(async ({ cwd }: { cwd?: string }) => ({
      data: cwd ? [{ id: cwd === root ? "root-thread" : "nested-thread", cwd, sourceKind: "appServer", forkedFromId: null }] : [],
      nextCursor: null,
    }));
    const indexer = new ProjectIndexer(repositories, { listSessions } as unknown as CodexAdapter);

    await indexer.scanStartupRoots();

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions.mock.calls.map(([options]) => options.cwd).sort()).toEqual([nested, root].sort());
    expect(repositories.getProjectSession("root-thread")?.project_id).toBe("root");
    expect(repositories.getProjectSession("nested-thread")?.project_id).toBe("nested");
  });

  it("reruns a background scan requested while the previous pass is active", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-indexer-"));
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    repositories.insertProject(project("root", root));
    let releaseFirst: ((value: { data: never[]; nextCursor: null }) => void) | undefined;
    const listSessions = vi.fn()
      .mockImplementationOnce(() => new Promise<{ data: never[]; nextCursor: null }>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce({ data: [], nextCursor: null });
    const indexer = new ProjectIndexer(repositories, { listSessions } as unknown as CodexAdapter);
    const completed = vi.fn(); indexer.on("scanComplete", completed);

    const first = indexer.scanAll();
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    const queued = indexer.scanAll();
    releaseFirst?.({ data: [], nextCursor: null });
    await Promise.all([first, queued]);

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(completed).toHaveBeenCalledTimes(2);
  });

  it("discovers CLI, VS Code, and App Server Sessions and assigns nested cwd to the longest Project", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-web-indexer-"));
    const nested = path.join(root, "packages", "api");
    mkdirSync(nested, { recursive: true });
    mkdirSync(path.join(root, "src"));
    const repositories = new Repositories(path.join(root, "app.db")); databases.push(repositories);
    repositories.insertProject(project("root", root));
    repositories.insertProject({ ...project("api", nested), orderIndex: 1 });
    const listSessions = vi.fn(async () => ({ data: [
      { id: "cli", cwd: root, sourceKind: "cli", forkedFromId: null },
      { id: "vscode", cwd: path.join(root, "src"), sourceKind: "vscode", forkedFromId: null },
      { id: "web", cwd: nested, sourceKind: "appServer", forkedFromId: null },
    ], nextCursor: null }));
    const indexer = new ProjectIndexer(repositories, { listSessions } as unknown as CodexAdapter);

    await indexer.scanAll();

    expect(repositories.getProjectSession("cli")).toMatchObject({ project_id: "root", source_kind: "cli" });
    expect(repositories.getProjectSession("vscode")).toMatchObject({ project_id: "root", source_kind: "vscode" });
    expect(repositories.getProjectSession("web")).toMatchObject({ project_id: "api", source_kind: "appServer" });
  });
});
