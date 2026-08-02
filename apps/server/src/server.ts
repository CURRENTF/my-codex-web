import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { CodexAdapter, OperationUncertainError, type ReviewTarget } from "@codex-web/codex-adapter";
import { config } from "./config.js";
import { Repositories } from "./database.js";
import { DirectoryBrowserError, listDirectories } from "./directory-browser.js";
import { EventGateway } from "./event-gateway.js";
import { pickDirectory, revealDirectory } from "./native-directory-picker.js";
import { ProjectIndexer } from "./project-indexer.js";
import { RequestDeduplicator } from "./request-deduplicator.js";
import { ThreadRuntimeRegistry } from "./runtime-registry.js";
import { isAllowedSocketContext, localRequestError, localSecurityAllowLists, parseCookieHeader } from "./local-security.js";
import { ActiveTurnConflictError, ActiveTurnIdentityError, ForkBoundaryError, ProjectUnavailableError, SessionDisconnectedError, SessionService, SideChatCloseTimeoutError, SteerConflictError, UncertainTurnAppliedError, UnknownSkillError } from "./session-service.js";
import { KeyedOperationLock } from "./keyed-operation-lock.js";
import { ConnectionRecovery, type AppServerConnectionState } from "./connection-recovery.js";
import { safeErrorForLog } from "./safe-error.js";
import { LoginAttemptLimiter, verifyPassword } from "./password-auth.js";
import { AttachmentStore, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, streamLocalFile } from "./attachment-store.js";
import { acceptsSpaDocument } from "./spa-fallback.js";
import { initialCodeServerStatus, probeCodeServer } from "./code-server.js";

const idSchema = z.string().min(1).max(200);
const requestIdSchema = z.string().uuid().or(z.string().min(12).max(200));
const settingsSchema = z.object({
  model: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional(),
  accessMode: z.enum(["fullAccess", "workspaceWrite", "readOnly"]).optional(),
});
const skillNamesSchema = z.array(z.string().trim().min(1).max(200)).max(20).default([]);
const attachmentIdsSchema = z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]);
const reviewTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uncommittedChanges") }),
  z.object({ type: z.literal("baseBranch"), branch: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal("commit"), sha: z.string().trim().min(1).max(200), title: z.string().max(500).nullable().default(null) }),
  z.object({ type: z.literal("custom"), instructions: z.string().trim().min(1).max(10_000) }),
]);

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
  const passwordRequired = config.passwordHash !== null;
  const loginLimiter = new LoginAttemptLimiter();
  const { allowedHosts, allowedOrigins } = localSecurityAllowLists(config.host, config.port, config.allowViteOrigin, config.publicOrigins);
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.cookie", "req.headers.x-csrf-token", "body.text", "body.password"] },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: config.trustProxy,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 0, parts: 1 } });

  const hasSession = (token: string | undefined) => secureEqual(token, sessionToken);
  const setSessionCookie = (reply: FastifyReply) => {
    reply.setCookie(config.sessionCookieName, sessionToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.cookieSecure,
      path: "/",
    });
  };

  const repositories = new Repositories(config.databasePath);
  const attachments = new AttachmentStore(config.dataDir);
  await attachments.initialize();
  const adapter = new CodexAdapter({
    cwd: config.projectRoot,
    codexHome: config.codexHome,
    codexCommand: config.codexCommand,
    version: config.version,
  });
  const authenticateSocket = (request: IncomingMessage) => {
    return isAllowedSocketContext({ host: request.headers.host, origin: request.headers.origin }, allowedHosts, allowedOrigins)
      && hasSession(parseCookieHeader(request.headers.cookie)[config.sessionCookieName]);
  };
  const events = new EventGateway(authenticateSocket);
  const runtimes = new ThreadRuntimeRegistry(events, repositories);
  const projectLocks = new KeyedOperationLock();
  const indexer = new ProjectIndexer(repositories, adapter, projectLocks);
  const sessions = new SessionService(repositories, adapter, indexer, runtimes, projectLocks, attachments);
  const mutations = new RequestDeduplicator();
  const once = <T>(request: { method: string; url: string }, clientRequestId: string, action: () => Promise<T> | T) =>
    mutations.run(`${request.method}\u0000${request.url}\u0000${clientRequestId}`, action);

  let startupPhase = true;
  let connectionState: AppServerConnectionState = "disconnected";
  const recovery = new ConnectionRecovery({
    reconcile: () => sessions.reconcileAfterReconnect(),
    onState: (state) => {
      connectionState = state;
      runtimes.handleConnection(state);
    },
    onRecovered: () => {
      if (!startupPhase && adapter.account) {
        void indexer.scanStartupRoots()
          .then(() => indexer.scanAllInBackground())
          .catch((error) => app.log.warn({ error: safeErrorForLog(error) }, "Failed to scan Projects after App Server reconnect"));
      }
    },
    onError: (error) => app.log.warn({ error: safeErrorForLog(error) }, "Failed to reconcile Runtime after App Server reconnect; retrying"),
  });
  adapter.on("connection", (event: { state: AppServerConnectionState }) => {
    void recovery.handle(event.state);
  });
  adapter.on("event", (event) => {
    const normalized = sessions.handleEvent(event);
    runtimes.handleEvent(normalized);
  });
  adapter.on("pendingRequest", (request) => sessions.handlePendingRequest(request));
  adapter.on("stderr", (line: string) => app.log.debug({ source: "codex-app-server", bytes: Buffer.byteLength(line) }, "Codex App Server wrote to stderr"));
  adapter.on("warning", (warning) => app.log.warn({ warning: safeErrorForLog(warning) }, "Codex Adapter warning"));
  adapter.on("error", (error) => app.log.error({ error: safeErrorForLog(error) }, "Codex Adapter error"));
  indexer.on("scanComplete", () => {
    events.publish("sessions.rescanned", { completedAt: Date.now() });
    void sessions.recoverDeferredChildren()
      .catch((error) => app.log.warn({ error: safeErrorForLog(error) }, "Deferred Codex child recovery failed; retrying after a later scan"));
  });
  indexer.on("scanError", (error) => app.log.warn({ error: safeErrorForLog(error) }, "Background Project scan failed"));
  sessions.on("deferredRecoveryError", (error) => app.log.warn(
    { error: safeErrorForLog(error) },
    "Deferred Codex child recovery failed; retrying on its bounded background schedule",
  ));

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const securityError = localRequestError(request.method, { host: request.headers.host, origin: request.headers.origin, fetchSite: request.headers["sec-fetch-site"] }, allowedHosts, allowedOrigins);
    if (securityError) return reply.code(403).send({ error: securityError });
    const pathname = request.url.split("?", 1)[0];
    if (pathname === "/api/health" || pathname === "/api/auth/status" || pathname === "/api/auth/login") return;
    if (pathname === "/api/bootstrap" && !passwordRequired) return;
    if (!hasSession(request.cookies[config.sessionCookieName])) {
      return reply.code(401).send({ error: passwordRequired ? "password_required" : "Invalid session" });
    }
    if (request.method !== "GET" && request.method !== "HEAD" && !secureEqual(request.headers["x-csrf-token"] as string | undefined, csrfToken)) {
      return reply.code(403).send({ error: "Invalid CSRF token" });
    }
    if (request.method !== "GET" && request.method !== "HEAD" && connectionState !== "connected") {
      return reply.code(503).send({ error: "Codex App Server is still reconnecting" });
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    const socketOrigins = [...allowedOrigins].map((origin) => origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:"));
    reply.header("content-security-policy", [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https: http:",
      `connect-src 'self' ${socketOrigins.join(" ")}`,
      "font-src 'self' data:",
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
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "attachment_too_large", message: `单个附件不能超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MiB。` });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", details: z.treeifyError(error) });
    if (error instanceof DirectoryBrowserError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    if (error instanceof SteerConflictError) return reply.code(409).send({ error: "turn_finished", message: error.message });
    if (error instanceof ForkBoundaryError) return reply.code(409).send({ error: "invalid_fork_boundary", message: error.message });
    if (error instanceof ActiveTurnConflictError) return reply.code(409).send({ error: "active_turn", message: error.message });
    if (error instanceof ActiveTurnIdentityError) return reply.code(409).send({ error: "active_turn_unknown", message: error.message });
    if (error instanceof ProjectUnavailableError) return reply.code(409).send({ error: "project_unavailable", message: error.message });
    if (error instanceof SessionDisconnectedError) return reply.code(409).send({ error: "session_disconnected", message: error.message });
    if (error instanceof UncertainTurnAppliedError) return reply.code(409).send({ error: "uncertain_turn_applied", message: error.message });
    if (error instanceof SideChatCloseTimeoutError) return reply.code(409).send({ error: "side_chat_still_running", message: error.message });
    if (error instanceof UnknownSkillError) return reply.code(400).send({ error: "unknown_skill", message: error.message, skillNames: error.skillNames });
    if (error instanceof OperationUncertainError) {
      return reply.code(503).send({
        error: "operation_uncertain",
        message: "Codex 未确认该操作结果；连接正在重启并重新同步。请先检查当前 Session，再决定是否重试。",
      });
    }
    app.log.error({ error: safeErrorForLog(error) }, "Request failed");
    return reply.code(500).send({ error: error instanceof Error ? error.message : "Unknown server error" });
  });

  app.get("/api/health", async (request) => {
    if (passwordRequired && !hasSession(request.cookies[config.sessionCookieName])) return { ok: true };
    return { ok: true, connection: connectionState, codexHome: config.codexHome };
  });
  app.get("/api/auth/status", async (request) => ({
    passwordRequired,
    authenticated: !passwordRequired || hasSession(request.cookies[config.sessionCookieName]),
  }));
  app.post("/api/auth/login", async (request, reply) => {
    const retryAfter = loginLimiter.retryAfterSeconds(request.ip);
    if (retryAfter > 0) {
      reply.header("retry-after", String(retryAfter));
      return reply.code(429).send({ error: "too_many_attempts", message: "尝试次数过多，请稍后再试。" });
    }
    const { password } = z.object({ password: z.string().min(1).max(256) }).parse(request.body);
    if (passwordRequired && !verifyPassword(password, config.passwordHash!)) {
      const blockedFor = loginLimiter.recordFailure(request.ip);
      if (blockedFor > 0) reply.header("retry-after", String(blockedFor));
      return reply.code(401).send({ error: "invalid_password", message: "密码不正确。" });
    }
    loginLimiter.recordSuccess(request.ip);
    setSessionCookie(reply);
    return { ok: true };
  });
  app.get("/api/bootstrap", async (_request, reply) => {
    reply.header("cache-control", "no-store, max-age=0");
    if (!passwordRequired) setSessionCookie(reply);
    return {
      eventSeq: events.currentSeq,
      connection: { state: connectionState, codexVersion: null },
      authReady: adapter.account !== null,
      csrfToken,
      codeServer: initialCodeServerStatus(config.codeServerUrl),
      projects: repositories.listProjects(),
      preferences: repositories.getPreferences(),
      models: adapter.models,
      runtimeStates: runtimes.list(),
      activeSideChats: runtimes.listSideChats(),
      itemDeltas: runtimes.listItemDeltas(),
      sessionPrefills: sessions.listPrefills(),
      pendingRequests: runtimes.listPendingRequests(),
    };
  });
  app.get("/api/code-server/status", async (_request, reply) => {
    reply.header("cache-control", "no-store, max-age=0");
    return probeCodeServer(config.codeServerUrl, config.codeServerHealthUrl);
  });
  app.post("/api/attachments", async (request, reply) => {
    const part = await request.file();
    if (!part || part.fieldname !== "file") return reply.code(400).send({ error: "attachment_missing", message: "请选择一个文件。" });
    return reply.code(201).send(await attachments.save(part));
  });
  app.get("/api/attachments/:attachmentId/content", async (request, reply) => {
    const attachmentId = z.string().uuid().parse((request.params as { attachmentId: string }).attachmentId);
    const download = z.object({ download: z.enum(["0", "1"]).optional() }).parse(request.query).download === "1";
    try {
      const content = await attachments.content(attachmentId);
      const disposition = download || content.metadata.kind === "file" ? "attachment" : "inline";
      reply.header("cache-control", "private, max-age=31536000, immutable");
      reply.header("content-disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(content.metadata.name)}`);
      reply.header("content-length", String(content.metadata.size));
      return reply.type(content.metadata.mimeType).send(streamLocalFile(content.path));
    } catch {
      return reply.code(404).send({ error: "attachment_not_found", message: "附件不存在或已过期。" });
    }
  });
  app.delete("/api/attachments/:attachmentId", async (request, reply) => {
    const attachmentId = z.string().uuid().parse((request.params as { attachmentId: string }).attachmentId);
    try {
      const removed = await attachments.removeDraft(attachmentId);
      return removed ? reply.code(204).send() : reply.code(409).send({ error: "attachment_claimed", message: "已发送的附件不能删除。" });
    } catch {
      return reply.code(404).send({ error: "attachment_not_found", message: "附件不存在或已过期。" });
    }
  });
  app.get("/api/local-images/:token/content", async (request, reply) => {
    const token = z.string().uuid().parse((request.params as { token: string }).token);
    const content = attachments.openLocalImage(token);
    if (!content || !existsSync(content.path)) return reply.code(404).send({ error: "image_not_found", message: "图片不存在。" });
    reply.header("cache-control", "private, max-age=31536000, immutable");
    reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(content.path))}`);
    return reply.type(content.mimeType).send(streamLocalFile(content.path));
  });
  app.get("/api/local-paths/:token/content", async (request, reply) => {
    const token = z.string().uuid().parse((request.params as { token: string }).token);
    const content = attachments.openLocalPath(token);
    if (!content || !existsSync(content.path)) return reply.code(404).send({ error: "image_not_found", message: "图片不存在。" });
    reply.header("cache-control", "private, no-store");
    reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(content.path))}`);
    return reply.type(content.mimeType).send(streamLocalFile(content.path));
  });
  app.get("/api/models", async () => adapter.models);
  app.get("/api/projects", async () => repositories.listProjects());
  app.get("/api/projects/:projectId/skills", async (request) => sessions.listProjectSkills(idSchema.parse((request.params as { projectId: string }).projectId)));
  app.get("/api/preferences", async () => repositories.getPreferences());
  app.patch("/api/preferences", async (request) => {
    const { clientRequestId, ...changes } = z.object({
    sidebarMode: z.enum(["recent", "projects"]).optional(), sortDirection: z.enum(["asc", "desc"]).optional(),
    sideChatWidth: z.number().min(28).max(65).optional(), lastProjectId: z.string().nullable().optional(),
    lastThreadId: z.string().nullable().optional(), fullAccessNoticeSeenProjects: z.array(idSchema).max(2_000).optional(), clientRequestId: requestIdSchema,
    }).parse(request.body);
    return once(request, clientRequestId, () => repositories.setPreferences(changes));
  });

  app.post("/api/system/pick-directory", async (request) => {
    const { clientRequestId } = z.object({ clientRequestId: requestIdSchema }).parse(request.body);
    return once(request, clientRequestId, async () => ({ path: await pickDirectory() }));
  });
  app.get("/api/system/directories", async (request) => {
    const { path: directoryPath } = z.object({ path: z.string().trim().max(4_096).optional() }).parse(request.query);
    return listDirectories(directoryPath);
  });
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
  app.patch("/api/sessions/:threadId/settings", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const { accessMode, clientRequestId } = z.object({
      accessMode: z.enum(["fullAccess", "workspaceWrite", "readOnly"]),
      clientRequestId: requestIdSchema,
    }).parse(request.body);
    return once(request, clientRequestId, () => sessions.setAccessModeOverride(threadId, accessMode));
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
    const body = settingsSchema.extend({ text: z.string().trim().max(100_000).default(""), skillNames: skillNamesSchema, attachmentIds: attachmentIdsSchema, clientRequestId: requestIdSchema, clientUserMessageId: requestIdSchema })
      .refine((value) => value.text.length > 0 || value.attachmentIds.length > 0, { message: "消息或附件至少需要一项" }).parse(request.body);
    return once(request, body.clientRequestId, () => sessions.startTurn(threadId, body.text, body, body.clientRequestId));
  });
  app.post("/api/sessions/:threadId/steer", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const body = z.object({ text: z.string().trim().max(100_000).default(""), skillNames: skillNamesSchema, attachmentIds: attachmentIdsSchema, expectedTurnId: idSchema, clientRequestId: requestIdSchema, clientUserMessageId: requestIdSchema })
      .refine((value) => value.text.length > 0 || value.attachmentIds.length > 0, { message: "消息或附件至少需要一项" }).parse(request.body);
    return once(request, body.clientRequestId, () => sessions.steer(threadId, body.text, body.expectedTurnId, body.clientUserMessageId, body.clientRequestId, body.skillNames, body.attachmentIds));
  });
  app.post("/api/sessions/:threadId/compact", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const { clientRequestId } = z.object({ clientRequestId: requestIdSchema }).parse(request.body);
    await once(request, clientRequestId, () => sessions.compact(threadId));
    return { ok: true };
  });
  app.post("/api/sessions/:threadId/review", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const { target, clientRequestId } = z.object({ target: reviewTargetSchema, clientRequestId: requestIdSchema }).parse(request.body);
    return once(request, clientRequestId, () => sessions.startReview(threadId, target as ReviewTarget));
  });
  app.post("/api/sessions/:threadId/interrupt", async (request) => {
    const { clientRequestId } = z.object({ clientRequestId: requestIdSchema }).parse(request.body);
    await once(request, clientRequestId, () => sessions.interrupt(idSchema.parse((request.params as { threadId: string }).threadId)));
    return { ok: true };
  });
  app.post("/api/sessions/:threadId/resolve-uncertain-turn", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const { clientRequestId } = z.object({ clientRequestId: requestIdSchema }).parse(request.body);
    return once(request, clientRequestId, () => sessions.resolveUncertainTurn(threadId));
  });
  app.post("/api/sessions/:threadId/forks", async (request) => {
    const threadId = idSchema.parse((request.params as { threadId: string }).threadId);
    const body = z.object({ lastTurnId: z.string().nullable(), inheritGoal: z.boolean().default(false), empty: z.boolean().default(false), prefill: z.string().max(100_000).optional(), clientRequestId: requestIdSchema }).parse(request.body);
    return once(request, body.clientRequestId, () => sessions.fork(threadId, body.lastTurnId, body.inheritGoal, body.clientRequestId, body.empty, body.prefill));
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
      if (!request.url.startsWith("/api/") && acceptsSpaDocument(request.raw.method ?? "", request.headers.accept)) {
        reply.type("text/html").send(createReadStream(path.join(webDist, "index.html")));
      } else reply.code(404).send({ error: "Not found" });
    });
  }

  app.server.on("upgrade", (request, socket, head) => {
    if (request.url === "/api/events") events.handleUpgrade(request, socket, head);
    else socket.destroy();
  });

  await adapter.start();
  await recovery.waitForCurrent();
  startupPhase = false;
  if (adapter.account && (connectionState as AppServerConnectionState) === "connected") {
    await indexer.scanStartupRoots();
    indexer.scanAllInBackground();
  }

  return {
    app, adapter, events, repositories,
    async close() {
      recovery.stop();
      sessions.dispose();
      events.close();
      adapter.stop();
      repositories.close();
      await app.close();
    },
  };
}
