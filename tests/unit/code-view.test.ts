import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeViewFiles, MAX_CODE_BYTES } from "../../apps/server/src/code-view";
import { codeViewUrl } from "../../apps/web/src/code-view-url";

describe("built-in workspace editor", () => {
  let base: string, root: string, target: string, files: CodeViewFiles;
  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "code-view-"));
    root = path.join(base, "project");
    await mkdir(root);
    target = path.join(root, "hello.ts");
    await writeFile(target, "export const hello = '你好';\r\n", { mode: 0o755 });
    files = new CodeViewFiles(() => [root], path.join(base, "private"));
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });
  it("round trips text, preserves mode, supports retry and rejects stale edits", async () => {
    const original = await files.read(root, target);
    expect(original.content).toContain("\r\n");
    const saved = await files.save(root, target, "updated\r\n", original.version);
    expect(await readFile(target, "utf8")).toBe("updated\r\n");
    expect((await stat(target)).mode & 0o777).toBe(0o755);
    expect(await files.save(root, target, saved.content, original.version)).toEqual(saved);
    await expect(files.save(root, target, "stale", original.version)).rejects.toMatchObject({ statusCode: 409 });
    await writeFile(target, "agent edit");
    await expect(files.save(root, target, "browser edit", saved.version)).rejects.toMatchObject({ statusCode: 409 });
    expect(await readFile(target, "utf8")).toBe("agent edit");
  });
  it("serializes two browser saves against one version", async () => {
    const original = await files.read(root, target);
    const results = await Promise.allSettled([files.save(root, target, "one", original.version), files.save(root, target, "two", original.version)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
  it("rejects traversal, unregistered roots, symlink escapes and protected directories", async () => {
    await writeFile(path.join(base, "outside"), "private");
    await symlink(path.join(base, "outside"), path.join(root, "escape"));
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, ".git", "config"), "private");
    await expect(files.read(root, "../outside")).rejects.toMatchObject({ statusCode: 403 });
    await expect(files.read(base, "outside")).rejects.toMatchObject({ statusCode: 403 });
    await expect(files.read(root, "escape")).rejects.toMatchObject({ statusCode: 403 });
    await expect(files.read(root, ".git/config")).rejects.toMatchObject({ statusCode: 403 });
    const listing = await files.list(root);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["hello.ts"]);
    expect(listing.parent).toBeNull();
  });
  it("rejects binary, invalid UTF-8, oversized and hard-linked files", async () => {
    for (const content of [Buffer.from([0, 1]), Buffer.from([255, 254]), Buffer.alloc(MAX_CODE_BYTES + 1, 97)]) {
      await writeFile(target, content);
      await expect(files.read(root, target)).rejects.toThrow();
    }
    await writeFile(target, "text");
    await link(target, path.join(root, "hardlink"));
    const original = await files.read(root, target);
    await expect(files.save(root, target, "changed", original.version)).rejects.toMatchObject({ statusCode: 409 });
    expect(await readFile(target, "utf8")).toBe("text");
  });
  it("encodes file paths and extracts line numbers", () => {
    const url = new URL(codeViewUrl("/work a", "/work a/b#?.ts:42"), "http://localhost");
    expect(url.searchParams.get("file")).toBe("/work a/b#?.ts");
    expect(url.searchParams.get("line")).toBe("42");
  });
});
