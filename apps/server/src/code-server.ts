import type { CodeServerStatus } from "@codex-web/shared-types";

type FetchCodeServer = (input: string, init: RequestInit) => Promise<Response>;

export function normalizeHttpUrl(name: string, value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must use HTTP or HTTPS`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must not contain credentials, a query, or a fragment`);
  return url.toString().replace(/\/$/, "");
}

export function defaultCodeServerHealthUrl(codeServerUrl: string | null): string | null {
  return codeServerUrl ? new URL("healthz", `${codeServerUrl}/`).toString() : null;
}

export function initialCodeServerStatus(url: string | null): CodeServerStatus {
  return { url, state: url ? "checking" : "unconfigured", checkedAt: null };
}

export async function probeCodeServer(
  url: string | null,
  healthUrl: string | null,
  fetchCodeServer: FetchCodeServer = fetch,
): Promise<CodeServerStatus> {
  if (!url || !healthUrl) return { url, state: "unconfigured", checkedAt: Date.now() };
  const checkedAt = Date.now();
  try {
    const response = await fetchCodeServer(healthUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel();
    return { url, state: response.ok ? "available" : "unavailable", checkedAt };
  } catch {
    return { url, state: "unavailable", checkedAt };
  }
}
