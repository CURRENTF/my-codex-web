import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { CodexAdapter } from "@codex-web/codex-adapter";
import { config } from "./config.js";
import { Repositories } from "./database.js";
import { EventGateway } from "./event-gateway.js";
import { pickDirectory } from "./native-directory-picker.js";
import { ProjectIndexer } from "./project-indexer.js";
import { ThreadRuntimeRegistry } from "./runtime-registry.js";
import { SessionService, SteerConflictError } from "./session-service.js";

const idSchema = z.string().min(1).max(200);
const requestIdSchema = z.string().uuid().or(z.string().min(12).max(200));
const settingsSchema = z.object({
  model: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional(),
  accessMode: z.enum(["fullAccess", "workspaceWrite", "readOnly"]).optional(),
});

function parseCookies(request: IncomingMessage): Record<string, string> {
  const header = request.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(header.split(";").map((part) => {
    const [key = "", ...value] = part.trim().split("=");
    return [decodeURIComponent(key), decodeURIComponent(value.join("="))];
  }));
}

function secureEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function createServer() {
  mkdirSync(path.join(config.dataDir, "logs"), { recursive: true, mode: 0o700 });
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const allowedOrigins = new Set([
    `http://${config.host}:${config.port}`,
    `http://localhost:${config.port}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ]);
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.cookie", "req.headers.x-csrf-token", "body.text"] },
    bodyLimit: 2 * 1024 * 1024,
  });
  await app.register(cookie);

  const repositories = new Repositories(config.databasePath);
  const adapter = new CodexAdapter({
    cwd: config.projectRoot,
    codexHome: config.codexHome,
    codexCommand: config.codexCommand,
    version: config.version,
  });
  const authenticateSocket = (request: IncomingMessage) => {
    const origin = request.headers.origin;
    return (!origin || allowedOrigins.has(origin)) && secureEqual(parseCookies(request).codex_web_session, sessionToken);
  };
  const events = new EventGateway(authenticateSocket);
  const runtimes = new ThreadRuntimeRegistry(events, repositories);
  const indexer = new ProjectIndexer(repositories, adapter);
  const sessions = new SessionService(repositories, adapter, indexer, runtimes);

  adapter.on("connection", (event: { state: "connected" | "connecting" | "disconnected" }) => runtimes.handleConnection(event.state));
  adapter.on("notification", (notification) => runtimes.handleNotification(notification));
  adapter.on("serverRequest", (request) => runtimes.handleServerRequest(request));
  adapter.on("stderr", (line: string) => app.log.debug({ source: "codex-app-server", line: line.trim().slice(0, 500) }));
  adapter.on("warning", (warning) => app.log.warn(warning));
  adapter.on("error", (error) => app.log.error(error));

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: "Invalid origin" });
    if (request.url === "/api/health" || request.url === "/api/bootstrap") return;
    if (!secureEqual(request.cookies.codex_web_session, sessionToken)) return reply.code(401).send({ error: "Invalid session" });
    if (request.method !== "GET" && request.method !== "HEAD" && !secureEqual(request.headers["x-csrf-token"] as string | undefined, csrfToken)) {
      return reply.code(403).send({ error: "Invalid CSRF token" });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", details: z.treeifyError(error) });
    if (error instanceof SteerConflictError) return reply.code(409).send({ error: "turn_finished", message: error.message });
    app.log.error(error);
    return reply.code(500).send({ error: error instanceof Error ? error.message : "Unknown server error" });
  });

  app.get("/api/health", async () => ({ ok: true, connection: adapter.connected ? "connected" : "disconnected", codexHome: config.codexHome }));
  app.get("/api/bootstrap", async (_request, reply) => {
    reply.setCookie("codex_web_session", sessionToken, { httpOnly: true, sameSite: "strict", secure: false, path: "/" });
    return {
      connection: { state: adapter.connected ? "connected" : "disconnected", codexVersion: null },
      authReady: adapter.account !== null,
      csrfToken,
      projects: repositories.listProjects(),
      preferences: repositories.getPreferences(),
      models: adapter.models,
      runtimeStates: runtimes.list(),
      activeSideChats: runtimes.listSideChats(),
    };
  });
  app.get("/api/models", async () => adapter.models);
  app.get("/api/projects", async () => repositories.listProjects());
  app.get("/api/preferences", async () => repositories.getPreferences());
  app.patch("/api/preferences", async (request) => repositories.setPreferences(z.object({
    sidebarMode: z.enum(["recent", "projects"]).optional(), sortDirection: z.enum(["asc", "desc"]).optional(),
    sideChatWidth: z.number().min(28).max(65).optional(), lastProjectId: z.string().nullable().optional(),
    lastThreadId: z.string().nullable().optional(), fullAccessNoticeSeen: z.boolean().optional(),
  }).parse(request.body)));

  app.post("/api/system/pick-directory", async () => ({ path: await pickDirectory() }));
  app.post("/api/projects", async (request) => {
    const body = z.object({ path: z.string().min(1), name: z.string().min(1).max(100).optional() }).parse(request.body);
    return indexer.addProject(body.path, body.name);
  });
  app.patch("/api/projects/:projectId", async (request) => {
    const projectId = idSchema.parse((request.params as { projectId: string }).projectId);
    const body = z.object({
      name: z.string().min(1).max(100).optional(), orderIndex: z.number().int().min(0).optional(),
      defaultModel: z.string().nullable().optional(), defaultReasoning: z.string().nullable().optional(),
      defaultAccessMode: z.enum(["fullAccess", "workspaceWrite", "readOnly"]).optional(),
    }).parse(request.body);
    return repositories.updateProject(projectId, body);
  });
  app.delete("/api/projects/:projectId", async (request, reply) => {
    repositories.deleteProject(idSchema.parse((request.params as { projectId: string }).projectId));
    return reply.code(204).send();
  });
  app.post("/api/projects/:projectId/rescan", async (request) => {
    const project = repositories.getProject(idSchema.parse((request.params as { projectId: string }).projectId));
    if (!project) throw new Error("Project not found");
    await indexer.scanRoot(project);
    void indexer.scanAll();
    return { ok: true };
  });

  app.get("/api/sessions", async (request) => {
    const query = z.object({ projectId: z.string().optional(), search: z.string().optional(), sortDirection: z.enum(["asc", "desc"]).optional() }).parse(request.query);
    return sessions.listSessions(query);
  });
  app.get("/api/sessions/:threadId", async (request) => sessions.readSession(idSchema.parse((request.params as { threadId: string }).threadId)));
  app.patch("/api/sessions/:threadId/name", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(request.body);
    await sessions.rename(threadId, name);
    return { ok: true };
  });
  app.post("/api/sessions/:threadId/archive", async (request) => {
    await sessions.archive(idSchema.parse((request.params as { threadId: string }).threadId));
    return { ok: true };
  });
  app.post("/api/projects/:projectId/sessions", async (request) => {
    const projectId = idSchema.parse((request.params as { projectId: string }).projectId);
    const body = settingsSchema.extend({ clientRequestId: requestIdSchema }).parse(request.body);
    return sessions.createSession(projectId, body, body.clientRequestId);
  });
  app.post("/api/sessions/:threadId/turns", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const body = settingsSchema.extend({ text: z.string().trim().min(1).max(100_000), clientRequestId: requestIdSchema, clientUserMessageId: requestIdSchema }).parse(request.body);
    return sessions.startTurn(threadId, body.text, body, body.clientRequestId);
  });
  app.post("/api/sessions/:threadId/steer", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const body = z.object({ text: z.string().trim().min(1), expectedTurnId: idSchema, clientRequestId: requestIdSchema, clientUserMessageId: requestIdSchema }).parse(request.body);
    return sessions.steer(threadId, body.text, body.expectedTurnId, body.clientUserMessageId, body.clientRequestId);
  });
  app.post("/api/sessions/:threadId/interrupt", async (request) => {
    await sessions.interrupt(idSchema.parse((request.params as { threadId: string }).threadId));
    return { ok: true };
  });
  app.post("/api/sessions/:threadId/forks", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const body = z.object({ lastTurnId: z.string().nullable(), inheritGoal: z.boolean().default(false), clientRequestId: requestIdSchema }).parse(request.body);
    return sessions.fork(threadId, body.lastTurnId, body.inheritGoal, body.clientRequestId);
  });
  app.get("/api/sessions/:threadId/goal", async (request) => adapter.getGoal(idSchema.parse((request.params as { threadId: string }).threadId)));
  app.put("/api/sessions/:threadId/goal", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const body = z.object({ objective: z.string().min(1).max(2_000).optional(), status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]).optional(), tokenBudget: z.number().int().positive().nullable().optional() }).parse(request.body);
    return adapter.setGoal({ threadId, ...body });
  });
  app.delete("/api/sessions/:threadId/goal", async (request, reply) => {
    await adapter.clearGoal(idSchema.parse((request.params as { threadId: string }).threadId));
    return reply.code(204).send();
  });
  app.post("/api/sessions/:threadId/side-chat", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const { anchorTurnId } = z.object({ anchorTurnId: z.string().nullable().default(null) }).parse(request.body ?? {});
    return sessions.createSideChat(threadId, anchorTurnId);
  });
  app.delete("/api/side-chats/:sideThreadId", async (request, reply) => {
    await sessions.closeSideChat(idSchema.parse((request.params as { sideThreadId: string }).sideThreadId));
    return reply.code(204).send();
  });
  app.post("/api/pending-requests/:requestId/respond", async (request) => {
    const requestId = idSchema.parse((request.params as { requestId: string }).requestId);
    const { allow } = z.object({ allow: z.boolean() }).parse(request.body);
    await sessions.respondPendingRequest(requestId, allow);
    return { ok: true };
  });

  const webDist = path.join(config.projectRoot, "apps/web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.method === "GET" && !request.url.startsWith("/api/")) {
        reply.type("text/html").send(createReadStream(path.join(webDist, "index.html")));
      } else reply.code(404).send({ error: "Not found" });
    });
  }

  app.server.on("upgrade", (request, socket, head) => {
    if (request.url === "/api/events") events.handleUpgrade(request, socket, head);
    else socket.destroy();
  });

  await adapter.start();
  if (adapter.account) void indexer.scanAll();

  return {
    app, adapter, events, repositories,
    async close() {
      events.close();
      adapter.stop();
      repositories.close();
      await app.close();
    },
  };
}
