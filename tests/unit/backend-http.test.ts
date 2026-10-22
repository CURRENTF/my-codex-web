import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ directory: "" }));
vi.mock("@codex-web/codex-adapter", async (original) => {
  const actual = await original<typeof import("@codex-web/codex-adapter")>();
  const { EventEmitter } = await import("node:events");
  return { ...actual, CodexAdapter: class extends EventEmitter {
    connected = false; account = null; models = [];
    async start() {} stop() {}
  } };
});
vi.mock("../../apps/server/src/config.js", () => ({ config: {
  host: "127.0.0.1", port: 7373, dataDir: state.directory, databasePath: `${state.directory}/app.db`, projectRoot: state.directory,
  codexHome: `${state.directory}/codex`, codexCommand: "unused", piCommand: path.resolve("tests/fixtures/pi-rpc.mjs"), agyCommand: path.resolve("tests/fixtures/agy-cli.mjs"), version: "test",
  sessionCookieName: "backend_test", passwordHash: null, cookieSecure: false, allowViteOrigin: false, publicOrigins: [], trustProxy: false,
  updateRepository: state.directory, updateRemote: "origin", updateBranch: "main", updateRestartCommand: null,
} }));
let server: Awaited<ReturnType<typeof import("../../apps/server/src/server.js").createServer>>;
let cookie: string, csrf: string;
const headers = () => ({ host: "127.0.0.1:7373", origin: "http://127.0.0.1:7373", cookie, "x-csrf-token": csrf });
beforeAll(async () => {
  vi.stubEnv("LOG_LEVEL", "silent");
  state.directory = await realpath(await mkdtemp(path.join(tmpdir(), "backend-http-")));
  const { createServer } = await import("../../apps/server/src/server.js"); server = await createServer();
  const response = await server.app.inject({ url: "/api/bootstrap", headers: { host: "127.0.0.1:7373" } });
  cookie = `${response.cookies[0]!.name}=${response.cookies[0]!.value}`; csrf = response.json().csrfToken;
});
afterAll(async () => { await server?.close(); vi.unstubAllEnvs(); await rm(state.directory, { recursive: true, force: true }); });
it("creates and continues Pi through HTTP with Codex unavailable, without inheriting Codex project defaults", async () => {
  const catalog = await server.app.inject({ url: "/api/backends", headers: headers() });
  expect(catalog.json().map((item: any) => [item.id, item.available])).toEqual([["codex", false], ["pi", true], ["agy", true]]);
  const projectResponse = await server.app.inject({ method: "POST", url: "/api/projects", headers: headers(), payload: { path: state.directory, clientRequestId: randomUUID() } });
  expect(projectResponse.statusCode, projectResponse.body).toBe(200);
  const project = projectResponse.json();
  await server.app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, headers: headers(), payload: { defaultModel: "codex-model", defaultReasoning: "high", defaultAccessMode: "readOnly", clientRequestId: randomUUID() } });
  const response = await server.app.inject({ method: "POST", url: `/api/projects/${project.id}/sessions`, headers: headers(), payload: { backend: "pi", clientRequestId: randomUUID() } });
  expect(response.statusCode, response.body).toBe(200);
  const id = response.json().thread.id;
  expect(id).toMatch(/^pi:/); expect(response.json().settings).toMatchObject({ model: "test/local", reasoning: "off", accessMode: "fullAccess" });
  expect(response.json()).toMatchObject({ goal: null, runtime: { threadId: id, state: "idle", pendingRequestIds: [] }, thread: { turns: [] } });
  const read = await server.app.inject({ url: `/api/sessions/${id}`, headers: headers() });
  expect(read.statusCode, read.body).toBe(200); expect(read.json().settings.accessMode).toBe("fullAccess");
  const prompt = await server.app.inject({ method: "POST", url: `/api/sessions/${id}/turns`, headers: headers(), payload: { text: "handled", clientRequestId: randomUUID(), clientUserMessageId: randomUUID() } });
  expect(prompt.statusCode, prompt.body).toBe(200);
  const after = await server.app.inject({ url: `/api/sessions/${id}`, headers: headers() });
  expect(after.json().runtime.state).not.toBe("running"); expect(after.json().thread.turns[0].status).toBe("completed");
  const permissions = await server.app.inject({ method: "PATCH", url: `/api/sessions/${id}/settings`, headers: headers(), payload: { accessMode: "readOnly", clientRequestId: randomUUID() } });
  expect(permissions.statusCode).toBe(400);
  const invalidBackend = await server.app.inject({ method: "POST", url: `/api/projects/${project.id}/sessions`, headers: headers(), payload: { backend: "other", clientRequestId: randomUUID() } });
  expect(invalidBackend.statusCode).toBe(400);
});

it("creates agy with isolated defaults and supports HTTP streaming lifecycle while Codex is offline", async () => {
  const project = (await server.app.inject({ method: "POST", url: "/api/projects", headers: headers(), payload: { path: state.directory, clientRequestId: randomUUID() } })).json();
  const response = await server.app.inject({ method: "POST", url: `/api/projects/${project.id}/sessions`, headers: headers(), payload: { backend: "agy", clientRequestId: randomUUID() } });
  expect(response.statusCode, response.body).toBe(200);
  const id = response.json().thread.id;
  expect(id).toMatch(/^agy:/); expect(response.json().settings).toMatchObject({ model: "fixture-model", reasoning: "default", accessMode: "fullAccess" });
  expect(response.json()).toMatchObject({ goal: null, runtime: { threadId: id, state: "idle", pendingRequestIds: [] }, thread: { turns: [] } });
  const prompt = await server.app.inject({ method: "POST", url: `/api/sessions/${id}/turns`, headers: headers(), payload: { text: "hello", clientRequestId: randomUUID(), clientUserMessageId: randomUUID() } });
  expect(prompt.statusCode, prompt.body).toBe(200);
  await vi.waitFor(async () => {
    const after = await server.app.inject({ url: `/api/sessions/${id}`, headers: headers() });
    expect(after.json().thread.turns[0].status).toBe("completed");
    expect(after.json().runtime.state).not.toBe("running");
  });
  const permissions = await server.app.inject({ method: "PATCH", url: `/api/sessions/${id}/settings`, headers: headers(), payload: { accessMode: "readOnly", clientRequestId: randomUUID() } });
  expect(permissions.statusCode).toBe(400);
});
