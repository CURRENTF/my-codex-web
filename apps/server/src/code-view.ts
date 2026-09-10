import { constants } from "node:fs";
import { open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { KeyedOperationLock } from "./keyed-operation-lock.js";

export const MAX_CODE_BYTES = 1024 * 1024;
export class CodeViewError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
const version = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Human-operated file access uses the Web service's host permissions. */
export class CodeViewFiles {
  private locks = new KeyedOperationLock();

  private async resolve(rootInput: string, input: string) {
    const root = await realpath(rootInput);
    const target = await realpath(path.resolve(root, input || "."));
    return { root, target };
  }

  async list(rootInput: string, input = ".") {
    const { root, target } = await this.resolve(rootInput, input);
    const entries = (await readdir(target, { withFileTypes: true }))
      .filter((entry) => (entry.isDirectory() || entry.isFile()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return { root, path: target, parent: target === path.dirname(target) ? null : path.dirname(target), truncated: entries.length > 2000,
      entries: entries.slice(0, 2000).map((entry) => ({ name: entry.name, path: path.join(target, entry.name), directory: entry.isDirectory() })) };
  }

  private async bytes(target: string) {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new CodeViewError(400, "请选择普通文本文件。");
      if (metadata.size > MAX_CODE_BYTES) throw new CodeViewError(413, "仅支持 1 MiB 以内的文本文件。");
      const buffer = Buffer.alloc(MAX_CODE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_CODE_BYTES) throw new CodeViewError(413, "文件过大。");
      const data = buffer.subarray(0, length);
      try { new TextDecoder("utf-8", { fatal: true }).decode(data); }
      catch { throw new CodeViewError(415, "仅支持 UTF-8 文本文件。"); }
      if (data.includes(0)) throw new CodeViewError(415, "二进制文件不能在 Code View 中编辑。");
      return { data, metadata };
    } finally { await handle.close(); }
  }

  async read(root: string, input: string) {
    const { target } = await this.resolve(root, input);
    const { data } = await this.bytes(target);
    return { path: target, content: data.toString("utf8"), version: version(data) };
  }

  async save(root: string, input: string, content: string, expectedVersion: string) {
    const { target } = await this.resolve(root, input);
    return this.locks.withKey(target, async () => {
      const next = Buffer.from(content, "utf8");
      if (next.length > MAX_CODE_BYTES || next.includes(0)) throw new CodeViewError(413, "内容必须是 1 MiB 以内的文本。");
      const { data, metadata } = await this.bytes(target);
      // A lost response can safely be retried without creating another write.
      if (version(data) === version(next)) return { path: target, content, version: version(next) };
      if (version(data) !== expectedVersion) throw new CodeViewError(409, "文件已被其他操作修改。请保留你的内容，重新读取后再合并。");
      if (metadata.nlink !== 1) throw new CodeViewError(409, "暂不支持保存硬链接文件。");
      const temporary = path.join(path.dirname(target), `.code-view-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", metadata.mode & 0o777);
        try { await file.writeFile(next); await file.chmod(metadata.mode & 0o777); await file.sync(); }
        finally { await file.close(); }
        const resolved = await this.resolve(root, input);
        const current = await stat(target);
        if (resolved.target !== target || current.ino !== metadata.ino || version((await this.bytes(target)).data) !== expectedVersion) {
          throw new CodeViewError(409, "保存期间文件发生变化，请重新读取后合并。");
        }
        await rename(temporary, target);
      } finally { await rm(temporary, { force: true }); }
      return { path: target, content, version: version(next) };
    });
  }
}
