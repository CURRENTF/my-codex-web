import { afterEach, describe, expect, it, vi } from "vitest";
import { appBasePath, appStorageKey, appUrl } from "../apps/web/src/app-base";

afterEach(() => vi.unstubAllGlobals());
function base(href: string | null) {
  vi.stubGlobal("document", { querySelector: () => href === null ? null : { getAttribute: () => href } });
}
describe("path-mounted app URLs", () => {
  it("isolates per-instance browser data while keeping root keys", () => {
    base("/");
    expect(appStorageKey("history")).toBe("history");
    base("/pro6000/");
    expect(appStorageKey("history")).toBe("history:/pro6000/");
    base("/h100/");
    expect(appStorageKey("history")).toBe("history:/h100/");
  });
  it("keeps direct-port and server-side URLs unchanged", () => {
    expect(appBasePath()).toBe("/");
    base(null);
    expect(appUrl("/api/events")).toBe("/api/events");
  });
  it("prefixes API, code view and home links without double prefixes", () => {
    base("/pro6000-codex-web/");
    expect(appBasePath()).toBe("/pro6000-codex-web/");
    for (const path of ["/api/events", "/code?root=%2Ftmp", "/", "/api/code/download?a=b"]) {
      expect(appUrl(path)).toBe(`/pro6000-codex-web${path}`);
      expect(appUrl(appUrl(path))).toBe(appUrl(path));
    }
  });
  it("leaves external, data, blob and relative URLs alone", () => {
    base("/mount/");
    for (const url of ["https://example.com/a", "//example.com/a", "data:image/png;base64,a", "blob:a", "assets/a.js"]) {
      expect(appUrl(url)).toBe(url);
    }
  });
  it("ignores non-local bases and normalizes the trailing slash", () => {
    for (const href of ["https://example.com/", "//example.com/", "relative"]) {
      base(href);
      expect(appBasePath()).toBe("/");
    }
    base("/mount");
    expect(appBasePath()).toBe("/mount/");
  });
});
