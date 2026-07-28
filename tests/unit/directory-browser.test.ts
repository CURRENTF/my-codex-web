import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DirectoryBrowserError, listDirectories } from "../../apps/server/src/directory-browser";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directoryPath) => rm(directoryPath, { recursive: true, force: true })));
});

describe("directory browser", () => {
  it("lists only folders, keeps directory symlinks, and puts hidden entries last", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-web-directory-browser-"));
    temporaryRoots.push(root);
    await Promise.all([
      mkdir(path.join(root, "project10")),
      mkdir(path.join(root, "project2")),
      mkdir(path.join(root, ".hidden")),
      writeFile(path.join(root, "README.md"), "not a directory"),
    ]);
    await symlink(path.join(root, "project2"), path.join(root, "linked-project"));

    const listing = await listDirectories(root);

    const canonicalRoot = await realpath(root);
    expect(listing.currentPath).toBe(canonicalRoot);
    expect(listing.parentPath).toBe(path.dirname(canonicalRoot));
    expect(listing.entries.map((entry) => entry.name)).toEqual(["linked-project", "project2", "project10", ".hidden"]);
    expect(listing.entries.find((entry) => entry.name === "linked-project")).toMatchObject({ symbolicLink: true });
    expect(listing.entries.find((entry) => entry.name === ".hidden")).toMatchObject({ hidden: true });
    expect(listing.entries.some((entry) => entry.name === "README.md")).toBe(false);
  });

  it("rejects relative paths and files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-web-directory-browser-"));
    temporaryRoots.push(root);
    const filePath = path.join(root, "file.txt");
    await writeFile(filePath, "not a directory");

    await expect(listDirectories("relative/path")).rejects.toMatchObject<Partial<DirectoryBrowserError>>({
      code: "invalid_directory",
      statusCode: 400,
      message: "请输入绝对路径。",
    });
    await expect(listDirectories(filePath)).rejects.toMatchObject<Partial<DirectoryBrowserError>>({
      code: "invalid_directory",
      statusCode: 400,
      message: "所选路径不是文件夹。",
    });
  });

  it("reports a nonexistent folder as an invalid client path", async () => {
    await expect(listDirectories(path.join(tmpdir(), `missing-codex-web-directory-${crypto.randomUUID()}`))).rejects.toMatchObject<Partial<DirectoryBrowserError>>({
      code: "invalid_directory",
      statusCode: 400,
      message: "文件夹不存在或路径无效。",
    });
  });
});
