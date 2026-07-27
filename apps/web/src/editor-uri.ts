export function vscodeFileUri(filePath: string, remoteAuthority: string | null = null): string {
  const encodedPath = filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  if (remoteAuthority) return `vscode://vscode-remote/${remoteAuthority}${encodedPath.startsWith("/") ? "" : "/"}${encodedPath}`;
  return `vscode://file${encodedPath.startsWith("/") ? "" : "/"}${encodedPath}`;
}
