export function localRequestError(
  method: string,
  headers: { host?: string; origin?: string; fetchSite?: string },
  allowedHosts: ReadonlySet<string>,
  allowedOrigins: ReadonlySet<string>,
): string | null {
  if (!headers.host || !allowedHosts.has(headers.host)) return "Invalid host";
  if (headers.origin && !allowedOrigins.has(headers.origin)) return "Invalid origin";
  if (headers.fetchSite && headers.fetchSite !== "same-origin" && headers.fetchSite !== "none") return "Cross-site request denied";
  if (method !== "GET" && method !== "HEAD" && !headers.origin) return "Missing origin";
  return null;
}

export function isAllowedSocketContext(
  headers: { host?: string; origin?: string },
  allowedHosts: ReadonlySet<string>,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  return !!headers.host && allowedHosts.has(headers.host) && !!headers.origin && allowedOrigins.has(headers.origin);
}
