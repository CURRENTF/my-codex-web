import { describe, expect, it } from "vitest";
import { directoryBreadcrumbs } from "../../apps/web/src/components/ProjectDirectoryDialog";

describe("ProjectDirectoryDialog breadcrumbs", () => {
  it("builds navigable POSIX path segments", () => {
    expect(directoryBreadcrumbs("/home/haojitai/projects/Sparse-vLLM")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "haojitai", path: "/home/haojitai" },
      { label: "projects", path: "/home/haojitai/projects" },
      { label: "Sparse-vLLM", path: "/home/haojitai/projects/Sparse-vLLM" },
    ]);
  });

  it("normalizes Windows separators without losing the drive", () => {
    expect(directoryBreadcrumbs("C:\\Users\\k\\project")).toEqual([
      { label: "C:", path: "C:/" },
      { label: "Users", path: "C:/Users" },
      { label: "k", path: "C:/Users/k" },
      { label: "project", path: "C:/Users/k/project" },
    ]);
  });
});
