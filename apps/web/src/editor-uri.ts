export function vscodeFileUri(filePath: string): string {
  const encodedPath = filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `vscode://file${encodedPath.startsWith("/") ? "" : "/"}${encodedPath}`;
}
