import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, authenticateWebUi, bootstrap, isPasswordRequiredError } from "../../apps/web/src/api";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("web API security context", () => {
  it("bypasses bootstrap caches and retries a write once with refreshed CSRF state", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    let bootstrapCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      if (path === "/api/bootstrap") {
        bootstrapCount += 1;
        return json({ csrfToken: bootstrapCount === 1 ? "old-token" : "new-token" });
      }
      const header = new Headers(init.headers).get("x-csrf-token");
      return header === "new-token" ? json({ ok: true }) : json({ error: "Invalid CSRF token" }, 403);
    }));

    await bootstrap();
    await expect(api<{ ok: boolean }>("/api/write", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true });

    expect(calls.map((call) => call.path)).toEqual(["/api/bootstrap", "/api/write", "/api/bootstrap", "/api/write"]);
    expect(calls.filter((call) => call.path === "/api/bootstrap").every((call) => call.init.cache === "no-store")).toBe(true);
    expect(new Headers(calls[1]?.init.headers).get("x-csrf-token")).toBe("old-token");
    expect(new Headers(calls[3]?.init.headers).get("x-csrf-token")).toBe("new-token");
  });

  it("submits Web UI passwords directly without leaking them into headers or a bootstrap retry", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      return json({ ok: true });
    }));

    await authenticateWebUi("test-password");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/api/auth/login");
    expect(calls[0]?.init.credentials).toBe("same-origin");
    expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ password: "test-password" });
  });

  it("recognizes the password-required bootstrap boundary", () => {
    expect(isPasswordRequiredError(new ApiError("Password required", 401, { error: "password_required" }))).toBe(true);
    expect(isPasswordRequiredError(new ApiError("Invalid session", 401, { error: "Invalid session" }))).toBe(false);
  });
});
