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
import { pickDirectory, revealDirectory } from "./native-directory-picker.js";
import { ProjectIndexer } from "./project-indexer.js";
import { RequestDeduplicator } from "./request-deduplicator.js";
import { ThreadRuntimeRegistry } from "./runtime-registry.js";
import { isAllowedSocketContext, localRequestError } from "./local-security.js";
import { ActiveTurnConflictError, ForkBoundaryError, SessionService, SteerConflictError } from "./session-service.js";

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
  const allowedHosts = new Set([
    `${config.host}:${config.port}`,
    `localhost:${config.port}`,
    "127.0.0.1:5173",
    "localhost:5173",
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
    return isAllowedSocketContext({ host: request.headers.host, origin: request.headers.origin }, allowedHosts, allowedOrigins)
      && secureEqual(parseCookies(request).codex_web_session, sessionToken);
  };
  const events = new EventGateway(authenticateSocket);
  const runtimes = new ThreadRuntimeRegistry(events, repositories);
  const indexer = new ProjectIndexer(repositories, adapter);
  const sessions = new SessionService(repositories, adapter, indexer, runtimes);
  const mutations = new RequestDeduplicator();
  const once = <T>(request: { method: string; url: string }, clientRequestId: string, action: () => Promise<T> | T) =>
    mutations.run(`${request.method}\u0000${request.url}\u0000${clientRequestId}`, action);

  let startupPhase = true;
  adapter.on("connection", (event: { state: "connected" | "connecting" | "disconnected" }) => {
    if (event.state !== "connected") {
      runtimes.handleConnection(event.state);
      return;
    }
    const scanAfterRecovery = !startupPhase;
    void sessions.reconcileAfterReconnect()
      .then(async () => {
        if (!scanAfterRecovery || !adapter.account) return;
        await indexer.scanStartupRoots();
        indexer.scanAllInBackground();
      })
      .catch((error) => app.log.warn({ error }, "Failed to reconcile Runtime after App Server reconnect"))
      .finally(() => { if (adapter.connected) runtimes.handleConnection("connected"); });
  });
  adapter.on("event", (event) => {
    runtimes.handleEvent(event);
    sessions.handleEvent(event);
  });
  adapter.on("pendingRequest", (request) => sessions.handlePendingRequest(request));
  adapter.on("stderr", (line: string) => app.log.debug({ source: "codex-app-server", bytes: Buffer.byteLength(line) }, "Codex App Server wrote to stderr"));
  adapter.on("warning", (warning) => app.log.warn(warning));
  adapter.on("error", (error) => app.log.error(error));
  indexer.on("scanComplete", () => events.publish("sessions.rescanned", { completedAt: Date.now() }));
  indexer.on("scanError", (error) => app.log.warn({ error }, "Background Project scan failed"));

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const securityError = localRequestError(request.method, { host: request.headers.host, origin: request.headers.origin, fetchSite: request.headers["sec-fetch-site"] }, allowedHosts, allowedOrigins);
    if (securityError) return reply.code(403).send({ error: securityError });
    if (request.url === "/api/health" || request.url === "/api/bootstrap") return;
    if (!secureEqual(request.cookies.codex_web_session, sessionToken)) return reply.code(401).send({ error: "Invalid session" });
    if (request.method !== "GET" && request.method !== "HEAD" && !secureEqual(request.headers["x-csrf-token"] as string | undefined, csrfToken)) {
      return reply.code(403).send({ error: "Invalid CSRF token" });
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("content-security-policy", [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      `connect-src 'self' ws://${config.host}:${config.port} ws://localhost:${config.port}`,
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "));
    reply.header("x-frame-options", "DENY");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", details: z.treeifyError(error) });
    if (error instanceof SteerConflictError) return reply.code(409).send({ error: "turn_finished", message: error.message });
    if (error instanceof ForkBoundaryError) return reply.code(409).send({ error: "invalid_fork_boundary", message: error.message });
    if (error instanceof ActiveTurnConflictError) return reply.code(409).send({ error: "active_turn", message: error.message });
    app.log.error(error);
    return reply.code(500).send({ error: error instanceof Error ? error.message : "Unknown server error" });
  });

  app.get("/api/health", async () => ({ ok: true, connection: adapter.connected ? "connected" : "disconnected", codexHome: config.codexHome }));
  app.get("/api/bootstrap", async (_request, reply) => {
    reply.header("cache-control", "no-store, max-age=0");
    reply.setCookie("codex_web_session", sessionToken, { httpOnly: true, sameSite: "strict", secure: false, path: "/" });
    return {
      eventSeq: events.currentSeq,
      connection: { state: adapter.connected ? "connected" : "disconnected", codexVersion: null },
      authReady: adapter.account !== null,
      csrfToken,
      projects: repositories.listProjects(),
      preferences: repositories.getPreferences(),
      models: adapter.models,
      runtimeStates: runtimes.list(),
      activeSideChats: runtimes.listSideChats(),
      itemDeltas: runtimes.listItemDeltas(),
      pendingRequests: runtimes.listPendingRequests(),
    };
  });
  app.get("/api/models", async () => adapter.models);
  app.get("/api/projects", async () => repositories.listProjects());
  app.get("/api/preferences", async () => repositories.getPreferences());
  app.patch("/api/preferences", async (request) => {
    const { clientRequestId, ...changes } = z.object({
    sidebarMode: z.enum(["recent", "projects"]).optional(), sortDirection: z.enum(["asc", "desc"]).optional(),
    sideChatWidth: z.number().min(28).max(65).optional(), lastProjectId: z.string().nullable().optional(),
    lastThreadId: z.string().nullable().optional(), fullAccessNoticeSeenProjects: z.array(idSchema).max(2_000).optional(), clientRequestId: requestIdSchema,
    }).parse(request.body);
    return once(request, clientRequestId, () => repositories.setPreferences(changes));
  });

  app.post("/api/system/pick-directory", async () => ({ path: await pickDirectory() }));
  app.post("/api/projects", async (request) => {
    const body = z.object({ path: z.string().min(1), name: z.string().min(1).max(100).optional(), clientRequestId: requestIdSchema }).parse(request.body);
    return once(request, body.clientRequestId, () => indexer.addProject(body.path, body.name));
  });
  app.patch("/api/projects/:projectId", async (request) => {
    const projectId = idSchema.parse((request.params as { projectId: string }).projectId);
    const { clientRequestId, ...body } = z.object({
      name: z.string().min(1).max(100).optional(), orderIndex: z.number().int().min(0).optional(),
      defaultModel: z.string().nullable().optional(), defaultReasoning: z.string().nullable().optional(),
      defaultAccessMode: z.enum(["fullAccess", "workspaceWrite", "readOnly"]).optional(),
      clientRequestId: requestIdSchema,
    }).parse(request.body);
    return once(request, clientRequestId, () => repositories.updateProject(projectId, body));
  });
  app.delete("/api/projects/:projectId", async (request, reply) => {
    const { clientRequestId } = z.object({ clientRequestId: requestIdSchema }).parse(request.body);
    await once(request, clientRequestId, () => sessions.removeProject(idSchema.parse((request.params as { projectId: string }).projectId)));
    return reply.code(204).send();
  });
  app.post("/api/projects/:projectId/rescan", async (request) => {
    const { clientRequestId } = z.object({ clientRequestId: requestIdSchema }).parse(request.body);
    const project = repositories.getProject(idSchema.parse((request.params as { projectId: string }).projectId));
    if (!project) throw new Error("Project not found");
    await once(request, clientRequestId, async () => { await indexer.scanRoot(project); indexer.scanAllInBackground(); });
    return { ok: true };
  });
  app.post("/api/projects/:projectId/reveal", async (request) => {
    const { clientRequestId } = z.object({ clientRequestId: requestIdSchema }).parse(request.body);
    const project = repositories.getProject(idSchema.parse((request.params as { projectId: string }).projectId));
    if (!project) throw new Error("Project not found");
    if (!project.available) throw new Error("Project directory is unavailable");
    await once(request, clientRequestId, () => revealDirectory(project.canonicalPath));
    return { ok: true };
  });

  app.get("/api/sessions", async (request) => {
    const query = z.object({ projectId: z.string().optional(), search: z.string().optional(), sortDirection: z.enum(["asc", "desc"]).optional() }).parse(request.query);
    return sessions.listSessions(query);
  });
  app.get("/api/sessions/:threadId", async (request) => sessions.readSession(idSchema.parse((request.params as { threadId: string }).threadId)));
  app.post("/api/sessions/:threadId/viewed", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const { clientRequestId } = z.object({ clientRequestId: requestIdSchema }).parse(request.body);
    await once(request, clientRequestId, () => sessions.markViewed(threadId));
    return { ok: true };
  });
  app.patch("/api/sessions/:threadId/name", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const { name, clientRequestId } = z.object({ name: z.string().min(1).max(200), clientRequestId: requestIdSchema }).parse(request.body);
    await once(request, clientRequestId, () => sessions.rename(threadId, name));
    return { ok: true };
  });
  app.patch("/api/sessions/:threadId/project", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const { projectId, clientRequestId } = z.object({ projectId: idSchema, clientRequestId: requestIdSchema }).parse(request.body);
    return once(request, clientRequestId, () => sessions.moveToProject(threadId, projectId));
  });
  app.post("/api/sessions/:threadId/archive", async (request) => {
    const { clientRequestId } = z.object({ clientRequestId: requestIdSchema }).parse(request.body);
    await once(request, clientRequestId, () => sessions.archive(idSchema.parse((request.params as { threadId: string }).threadId)));
    return { ok: true };
  });
  app.post("/api/projects/:projectId/sessions", async (request) => {
    const projectId = idSchema.parse((request.params as { projectId: string }).projectId);
    const body = settingsSchema.extend({ clientRequestId: requestIdSchema }).parse(request.body);
    return once(request, body.clientRequestId, () => sessions.createSession(projectId, body, body.clientRequestId));
  });
  app.post("/api/sessions/:threadId/turns", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const body = settingsSchema.extend({ text: z.string().trim().min(1).max(100_000), clientRequestId: requestIdSchema, clientUserMessageId: requestIdSchema }).parse(request.body);
    return once(request, body.clientRequestId, () => sessions.startTurn(threadId, body.text, body, body.clientRequestId));
  });
  app.post("/api/sessions/:threadId/steer", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const body = z.object({ text: z.string().trim().min(1), expectedTurnId: idSchema, clientRequestId: requestIdSchema, clientUserMessageId: requestIdSchema }).parse(request.body);
    return once(request, body.clientRequestId, () => sessions.steer(threadId, body.text, body.expectedTurnId, body.clientUserMessageId, body.clientRequestId));
  });
  app.post("/api/sessions/:threadId/interrupt", async (request) => {
    const { clientRequestId } = z.object({ clientRequestId: requestIdSchema }).parse(request.body);
    await once(request, clientRequestId, () => sessions.interrupt(idSchema.parse((request.params as { threadId: string }).threadId)));
    return { ok: true };
  });
  app.post("/api/sessions/:threadId/forks", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const body = z.object({ lastTurnId: z.string().nullable(), inheritGoal: z.boolean().default(false), empty: z.boolean().default(false), clientRequestId: requestIdSchema }).parse(request.body);
    return once(request, body.clientRequestId, () => sessions.fork(threadId, body.lastTurnId, body.inheritGoal, body.clientRequestId, body.empty));
  });
  app.get("/api/sessions/:threadId/goal", async (request) => sessions.getGoal(idSchema.parse((request.params as { threadId: string }).threadId)));
  app.put("/api/sessions/:threadId/goal", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const { clientRequestId, ...body } = z.object({ objective: z.string().min(1).max(2_000).optional(), status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]).optional(), tokenBudget: z.number().int().positive().nullable().optional(), clientRequestId: requestIdSchema }).parse(request.body);
    return once(request, clientRequestId, () => sessions.setGoal({ threadId, ...body }));
  });
  app.delete("/api/sessions/:threadId/goal", async (request, reply) => {
    const { clientRequestId } = z.object({ clientRequestId: requestIdSchema }).parse(request.body);
    await once(request, clientRequestId, () => sessions.clearGoal(idSchema.parse((request.params as { threadId: string }).threadId)));
    return reply.code(204).send();
  });
  app.post("/api/sessions/:threadId/side-chat", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const { anchorTurnId, clientRequestId } = z.object({ anchorTurnId: z.string().nullable().default(null), clientRequestId: requestIdSchema }).parse(request.body ?? {});
    return once(request, clientRequestId, () => sessions.createSideChat(threadId, anchorTurnId));
  });
  app.delete("/api/side-chats/:sideThreadId", async (request, reply) => {
    const { clientRequestId } = z.object({ clientRequestId: requestIdSchema }).parse(request.body);
    await once(request, clientRequestId, () => sessions.closeSideChat(idSchema.parse((request.params as { sideThreadId: string }).sideThreadId)));
    return reply.code(204).send();
  });
  app.post("/api/pending-requests/:requestId/respond", async (request) => {
    const requestId = idSchema.parse((request.params as { requestId: string }).requestId);
    const { allow, answers, clientRequestId } = z.object({
      allow: z.boolean(),
      answers: z.record(z.string().min(1).max(200), z.array(z.string().max(4_000)).max(10)).optional().default({}),
      clientRequestId: requestIdSchema,
    }).parse(request.body);
    await once(request, clientRequestId, () => sessions.respondPendingRequest(requestId, allow, answers));
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
  startupPhase = false;
  if (adapter.account) {
    await indexer.scanStartupRoots();
    indexer.scanAllInBackground();
  }

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
