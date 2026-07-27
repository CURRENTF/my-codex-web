import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAllowedSocketContext, localRequestError, localSecurityAllowLists, parseCookieHeader } from "../../apps/server/src/local-security";

const hosts = new Set(["127.0.0.1:7373"]);
const origins = new Set(["http://127.0.0.1:7373"]);
const serverSource = readFileSync(fileURLToPath(new URL("../../apps/server/src/server.ts", import.meta.url)), "utf8");

describe("local HTTP and WebSocket boundary", () => {
  it("requires exact Host and Origin for writes", () => {
    expect(localRequestError("POST", { host: "127.0.0.1:7373" }, hosts, origins)).toBe("Missing origin");
    expect(localRequestError("POST", { host: "evil.test", origin: "http://127.0.0.1:7373" }, hosts, origins)).toBe("Invalid host");
    expect(localRequestError("POST", { host: "127.0.0.1:7373", origin: "null" }, hosts, origins)).toBe("Invalid origin");
    expect(localRequestError("POST", { host: "127.0.0.1:7373", origin: "http://127.0.0.1:7373", fetchSite: "cross-site" }, hosts, origins)).toBe("Cross-site request denied");
    expect(localRequestError("POST", { host: "127.0.0.1:7373", origin: "http://127.0.0.1:7373", fetchSite: "same-origin" }, hosts, origins)).toBeNull();
  });

  it("allows origin-less health GETs but never origin-less WebSockets", () => {
    expect(localRequestError("GET", { host: "127.0.0.1:7373" }, hosts, origins)).toBeNull();
    expect(isAllowedSocketContext({ host: "127.0.0.1:7373" }, hosts, origins)).toBe(false);
    expect(isAllowedSocketContext({ host: "127.0.0.1:7373", origin: "http://127.0.0.1:7373" }, hosts, origins)).toBe(true);
  });

  it("treats malformed WebSocket cookies as unauthenticated instead of throwing", () => {
    expect(parseCookieHeader("codex_web_session=%")).toEqual({});
    expect(parseCookieHeader("codex_web_session=valid-token")).toEqual({ codex_web_session: "valid-token" });
  });

  it("trusts the Vite origin only when explicit development mode is enabled", () => {
    const production = localSecurityAllowLists("127.0.0.1", 7373);
    expect(production.allowedHosts.has("127.0.0.1:5173")).toBe(false);
    expect(production.allowedOrigins.has("http://127.0.0.1:5173")).toBe(false);

    const development = localSecurityAllowLists("127.0.0.1", 7373, true);
    expect(development.allowedHosts.has("127.0.0.1:5173")).toBe(true);
    expect(development.allowedOrigins.has("http://127.0.0.1:5173")).toBe(true);
  });

  it("allows only explicitly configured public reverse-proxy origins", () => {
    const production = localSecurityAllowLists("127.0.0.1", 12100, false, ["https://8.134.70.136:12100"]);
    expect(production.allowedHosts.has("8.134.70.136:12100")).toBe(true);
    expect(production.allowedOrigins.has("https://8.134.70.136:12100")).toBe(true);
    expect(production.allowedOrigins.has("http://8.134.70.136:12100")).toBe(false);
    expect(isAllowedSocketContext({
      host: "8.134.70.136:12100",
      origin: "https://8.134.70.136:12100",
    }, production.allowedHosts, production.allowedOrigins)).toBe(true);
  });

  it("allows bundled data fonts without weakening script or object CSP", () => {
    expect(serverSource).toContain("font-src 'self' data:");
    expect(serverSource).toContain("script-src 'self'");
    expect(serverSource).toContain("object-src 'none'");
  });
});
