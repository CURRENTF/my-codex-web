export function codeViewUrl(root: string, file?: string, line?: number | null): string {
  const query = new URLSearchParams({ root });
  if (file) {
    const location = file.match(/^(.*?):(\d+)(?::\d+)?$/);
    query.set("file", location ? location[1]! : file);
    if (line == null && location) line = Number(location[2]);
  }
  if (line != null) query.set("line", String(Math.max(1, Math.trunc(line))));
  return `/code?${query}`;
}
