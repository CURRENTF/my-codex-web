import { describe, expect, it } from "vitest";
import { isAllowedSocketContext, localRequestError, localSecurityAllowLists, parseCookieHeader } from "../../apps/server/src/local-security";

const hosts = new Set(["127.0.0.1:7373"]);
const origins = new Set(["http://127.0.0.1:7373"]);

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
});
