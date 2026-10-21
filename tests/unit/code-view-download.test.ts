import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testConfig = vi.hoisted(() => ({ directory: "" }));
vi.mock("@codex-web/codex-adapter", async (original) => {
  const actual = await original<typeof import("@codex-web/codex-adapter")>();
  const { EventEmitter } = await import("node:events");
  return { ...actual, CodexAdapter: class extends EventEmitter {
    account = null;
    models = [];
    async start() {}
    stop() {}
  } };
});
vi.mock("../../apps/server/src/config.js", () => ({ config: {
  host: "127.0.0.1", port: 7373, dataDir: testConfig.directory,
  databasePath: `${testConfig.directory}/app.db`, projectRoot: testConfig.directory,
  codexHome: `${testConfig.directory}/codex`, codexCommand: "unused", version: "test",
  sessionCookieName: "code_download_test", passwordHash: null, cookieSecure: false,
  allowViteOrigin: false, publicOrigins: [], trustProxy: false,
  updateRepository: testConfig.directory, updateRemote: "origin", updateBranch: "main", updateRestartCommand: null,
} }));

describe("authenticated Code View downloads", () => {
  let server: Awaited<ReturnType<typeof import("../../apps/server/src/server").createServer>>;
  let file: string;
  let cookie: string;
  const bytes = Buffer.from([0, 255, 128, 1, 2, 3]);
  const headers = () => ({ host: "127.0.0.1:7373", cookie });
  const url = (target = file) => `/api/code/download?${new URLSearchParams({ root: testConfig.directory, path: target })}`;
  beforeAll(async () => {
    vi.stubEnv("LOG_LEVEL", "silent");
    testConfig.directory = await realpath(await mkdtemp(path.join(tmpdir(), "code-download-http-")));
    file = path.join(testConfig.directory, "trace 中文 #1.nsys-rep");
    await writeFile(file, bytes);
    await mkdir(path.join(testConfig.directory, "codex"));
    const { createServer } = await import("../../apps/server/src/server");
    server = await createServer();
    const bootstrap = await server.app.inject({ url: "/api/bootstrap", headers: { host: "127.0.0.1:7373" } });
    const session = bootstrap.cookies[0]!;
    cookie = `${session.name}=${session.value}`;
  });
  afterAll(async () => {
    await server?.close();
    await rm(testConfig.directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("requires the same Web login and Host boundary as file preview", async () => {
    expect((await server.app.inject({ url: url(), headers: { host: "127.0.0.1:7373" } })).statusCode).toBe(401);
    expect((await server.app.inject({ url: url(), headers: { ...headers(), host: "untrusted.test" } })).statusCode).toBe(403);
  });

  it("isolates the HTML renderer without relaxing application CSP or authentication", async () => {
    const url = "/api/code/preview";
    expect((await server.app.inject({ url, headers: { host: "127.0.0.1:7373" } })).statusCode).toBe(401);
    const preview = await server.app.inject({ url, headers: headers() });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toContain("text/html");
    expect(preview.headers["cache-control"]).toBe("private, no-store");
    const policy = String(preview.headers["content-security-policy"]);
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(preview.headers["x-frame-options"]).toBe("SAMEORIGIN");
    const app = await server.app.inject({ url: "/api/bootstrap", headers: headers() });
    expect(app.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(app.headers["x-frame-options"]).toBe("DENY");
  });

  it("returns exact bytes and attachment headers with an encoded filename", async () => {
    const response = await server.app.inject({ url: url(), headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-length"]).toBe(String(bytes.length));
    expect(response.headers["content-disposition"]).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    const head = await server.app.inject({ method: "HEAD", url: url(), headers: headers() });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload).toHaveLength(0);
    expect(head.headers["content-length"]).toBe(String(bytes.length));
  });

  it("returns preview metadata for binary files and meaningful errors for invalid downloads", async () => {
    const preview = await server.app.inject({ url: `/api/code/file?${new URLSearchParams({ root: testConfig.directory, path: file })}`, headers: headers() });
    expect(preview.statusCode).toBe(415);
    expect(preview.json().file).toMatchObject({ path: file, size: bytes.length });
    expect((await server.app.inject({ url: url(path.join(testConfig.directory, "missing")), headers: headers() })).statusCode).toBe(404);
    expect((await server.app.inject({ url: url(testConfig.directory), headers: headers() })).statusCode).toBe(400);
  });
});
