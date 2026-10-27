import { appUrl } from "./app-base";

export function codeViewUrl(root: string, file?: string, line?: number | null): string {
  const query = new URLSearchParams({ root });
  if (file) {
    const location = file.match(/^(.*?):(\d+)(?::\d+)?$/);
    query.set("file", location ? location[1]! : file);
    if (line == null && location) line = Number(location[2]);
  }
  if (line != null) query.set("line", String(Math.max(1, Math.trunc(line))));
  return appUrl(`/code?${query}`);
}

export function fileDownloadUrl(root: string, file: string): string {
  return appUrl(`/api/code/download?${new URLSearchParams({ root, path: file.replace(/:\d+(?::\d+)?$/, "") })}`);
}

export function isDownloadOnlyFile(file: string): boolean {
  return /\.(?:nsys-rep|qdrep|ncu-rep|zip|tar|tgz|gz|bz2|xz|zst|7z)(?::\d+(?::\d+)?)?$/i.test(file);
}
