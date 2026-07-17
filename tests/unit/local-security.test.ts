import { describe, expect, it } from "vitest";
import { isAllowedSocketContext, localRequestError } from "../../apps/server/src/local-security";

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
});
