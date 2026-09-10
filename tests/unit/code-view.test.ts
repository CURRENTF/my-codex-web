import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink, link, stat } from "node:fs/promises";
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
    files = new CodeViewFiles();
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
  it("browses and edits external paths, symlink targets and hidden directories", async () => {
    await writeFile(path.join(base, "outside"), "external text");
    await symlink(path.join(base, "outside"), path.join(root, "escape"));
    for (const directory of [path.join(root, ".git"), path.join(root, ".codex"), path.join(base, "private")]) {
      await mkdir(directory);
      await writeFile(path.join(directory, "config"), "protected text");
    }
    for (const [browseRoot, input] of [
      [root, "../outside"], [base, "outside"], [root, "escape"],
      [root, path.join(base, "outside")], [root, ".git/config"],
      [root, ".codex/config"], [base, "private/config"],
    ]) {
      const data = await files.read(browseRoot!, input!);
      const content = `${data.content} updated`;
      await files.save(browseRoot!, input!, content, data.version);
      expect(await readFile(data.path, "utf8")).toBe(content);
    }
    const listing = await files.list(root);
    expect(listing.entries.map((entry) => entry.name)).toEqual([".codex", ".git", "hello.ts"]);
    expect(listing.parent).toBe(await realpath(base));
    expect((await files.list(root, "..")).entries.some((entry) => entry.name === "outside")).toBe(true);
    expect((await files.list(root, path.parse(root).root)).parent).toBeNull();
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
