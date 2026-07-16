import { describe, expect, it } from "vitest";
import type { Project } from "@codex-web/shared-types";
import { isPathInside, longestProjectMatch } from "../../apps/server/src/project-indexer";

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
});
