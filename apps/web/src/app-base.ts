// A path proxy supplies <base href="/mount/">; direct port access uses root.
export function appBasePath(): string {
  if (typeof document === "undefined") return "/";
  const href = document.querySelector("base")?.getAttribute("href");
  return href?.startsWith("/") && !href.startsWith("//") ? `${href.replace(/\/+$/, "")}/` : "/";
}

export function appUrl(url: string): string {
  const base = appBasePath();
  if (base === "/" || !url.startsWith("/") || url.startsWith("//") || url.startsWith(base)) return url;
  return `${base}${url.slice(1)}`;
}

export function appStorageKey(key: string): string {
  const base = appBasePath();
  return base === "/" ? key : `${key}:${base}`;
}
