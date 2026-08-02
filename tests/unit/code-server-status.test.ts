import { describe, expect, it, vi } from "vitest";
import { defaultCodeServerHealthUrl, initialCodeServerStatus, normalizeHttpUrl, probeCodeServer } from "../../apps/server/src/code-server";

describe("code-server status", () => {
  it("normalizes HTTP URLs and rejects unsafe URL components", () => {
    expect(normalizeHttpUrl("CODE_SERVER", " https://example.com/code/ ")).toBe("https://example.com/code");
    expect(() => normalizeHttpUrl("CODE_SERVER", "file:///tmp/code-server")).toThrow("must use HTTP or HTTPS");
    expect(() => normalizeHttpUrl("CODE_SERVER", "https://user:secret@example.com")).toThrow("must not contain credentials");
  });

  it("derives a health endpoint from a base-path deployment", () => {
    expect(defaultCodeServerHealthUrl("https://example.com/code")).toBe("https://example.com/code/healthz");
  });

  it("starts configured services in checking state", () => {
    expect(initialCodeServerStatus("https://example.com")).toMatchObject({ state: "checking", checkedAt: null });
    expect(initialCodeServerStatus(null)).toEqual({ url: null, state: "unconfigured", checkedAt: null });
  });

  it("reports a successful health response as available", async () => {
    const request = vi.fn(async () => new Response('{"status":"alive"}', { status: 200 }));
    const status = await probeCodeServer("https://example.com", "http://127.0.0.1:12334/healthz", request);
    expect(status).toMatchObject({ url: "https://example.com", state: "available" });
    expect(request).toHaveBeenCalledWith("http://127.0.0.1:12334/healthz", expect.objectContaining({ method: "GET", redirect: "manual" }));
  });

  it("keeps connection failures visible as unavailable", async () => {
    const status = await probeCodeServer("https://example.com", "http://127.0.0.1:12334/healthz", async () => { throw new Error("ECONNREFUSED"); });
    expect(status).toMatchObject({ state: "unavailable" });
  });
});
