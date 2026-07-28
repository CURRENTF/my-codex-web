import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
  symbolicLink: boolean;
}

export interface DirectoryListing {
  currentPath: string;
  parentPath: string | null;
  homePath: string;
  entries: DirectoryEntry[];
}

export class DirectoryBrowserError extends Error {
  constructor(
    readonly code: "invalid_directory" | "directory_unreadable",
    readonly statusCode: 400 | 403,
    message: string,
  ) {
    super(message);
    this.name = "DirectoryBrowserError";
  }
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function listDirectories(requestedPath?: string): Promise<DirectoryListing> {
  const inputPath = requestedPath?.trim() || homedir();
  if (!path.isAbsolute(inputPath)) {
    throw new DirectoryBrowserError("invalid_directory", 400, "请输入绝对路径。");
  }

  let currentPath: string;
  let children: Dirent<string>[];
  try {
    currentPath = await realpath(inputPath);
    if (!(await stat(currentPath)).isDirectory()) {
      throw new DirectoryBrowserError("invalid_directory", 400, "所选路径不是文件夹。");
    }
    children = await readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof DirectoryBrowserError) throw error;
    if (isFileSystemError(error) && (error.code === "EACCES" || error.code === "EPERM")) {
      throw new DirectoryBrowserError("directory_unreadable", 403, "当前服务用户没有权限读取此文件夹。");
    }
    if (isFileSystemError(error) && ["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code ?? "")) {
      throw new DirectoryBrowserError("invalid_directory", 400, "文件夹不存在或路径无效。");
    }
    throw error;
  }

  const entries = (await Promise.all(children.map(async (entry): Promise<DirectoryEntry | null> => {
    const childPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      return { name: entry.name, path: childPath, hidden: entry.name.startsWith("."), symbolicLink: false };
    }
    if (!entry.isSymbolicLink()) return null;
    try {
      if (!(await stat(childPath)).isDirectory()) return null;
      return { name: entry.name, path: childPath, hidden: entry.name.startsWith("."), symbolicLink: true };
    } catch {
      return null;
    }
  }))).filter((entry): entry is DirectoryEntry => entry !== null);

  entries.sort((left, right) => {
    if (left.hidden !== right.hidden) return left.hidden ? 1 : -1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });

  const rootPath = path.parse(currentPath).root;
  return {
    currentPath,
    parentPath: currentPath === rootPath ? null : path.dirname(currentPath),
    homePath: homedir(),
    entries,
  };
}
