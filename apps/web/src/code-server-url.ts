function codeServerPathQuery(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function codeServerBaseUrl(baseUrl: string): URL {
  return new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

export function codeServerFolderUrl(baseUrl: string, folderPath: string): string {
  const url = codeServerBaseUrl(baseUrl);
  url.search = `?folder=${codeServerPathQuery(folderPath)}`;
  return url.toString();
}

export function codeServerFileUrl(baseUrl: string, filePath: string, folderPath: string, line: number | null = null): string {
  const url = codeServerBaseUrl(baseUrl);
  const target = `vscode-remote://${url.host}${codeServerPathQuery(filePath)}${line === null ? "" : `:${Math.max(1, Math.trunc(line))}`}`;
  const payload = line === null
    ? [["openFile", target]]
    : [["gotoLineMode", "true"], ["openFile", target]];
  url.search = `?folder=${codeServerPathQuery(folderPath)}&payload=${encodeURIComponent(JSON.stringify(payload))}`;
  return url.toString();
}
