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

export function localSecurityAllowLists(host: string, port: number, allowViteOrigin = false, publicOrigins: readonly string[] = []): {
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
} {
  const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://${host}:${port}`, `http://localhost:${port}`]);
  for (const origin of publicOrigins) {
    const parsed = new URL(origin);
    allowedHosts.add(parsed.host);
    allowedOrigins.add(parsed.origin);
  }
  if (allowViteOrigin) {
    allowedHosts.add("127.0.0.1:5173");
    allowedHosts.add("localhost:5173");
    allowedOrigins.add("http://127.0.0.1:5173");
    allowedOrigins.add("http://localhost:5173");
  }
  return { allowedHosts, allowedOrigins };
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  try {
    return Object.fromEntries(header.split(";").map((part) => {
      const [key = "", ...value] = part.trim().split("=");
      return [decodeURIComponent(key), decodeURIComponent(value.join("="))];
    }));
  } catch {
    // WebSocket upgrades do not pass through Fastify's normal error boundary.
    // Treat malformed attacker-controlled cookie encoding as unauthenticated.
    return {};
  }
}
