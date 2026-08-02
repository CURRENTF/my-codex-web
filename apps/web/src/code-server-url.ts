export function codeServerFolderUrl(baseUrl: string, folderPath: string): string {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.searchParams.set("folder", folderPath);
  return url.toString();
}

export function codeServerFileUrl(baseUrl: string, filePath: string, folderPath: string, line: number | null = null): string {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.searchParams.set("folder", folderPath);
  url.searchParams.set("goto", `${filePath}${line === null ? "" : `:${Math.max(1, Math.trunc(line))}`}`);
  return url.toString();
}
