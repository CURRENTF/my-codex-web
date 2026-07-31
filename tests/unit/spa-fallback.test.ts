import { describe, expect, it } from "vitest";
import { acceptsSpaDocument } from "../../apps/server/src/spa-fallback.js";

describe("SPA fallback", () => {
  it("serves the app shell only for browser document navigation", () => {
    expect(acceptsSpaDocument("GET", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(true);
    expect(acceptsSpaDocument("GET", "image/avif,image/webp,image/*,*/*;q=0.8")).toBe(false);
    expect(acceptsSpaDocument("GET", "*/*")).toBe(false);
    expect(acceptsSpaDocument("HEAD", "text/html")).toBe(false);
  });
});
