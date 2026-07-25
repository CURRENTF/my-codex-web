import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

interface PendingRequest {
  method: string;
  operationUncertainOnDisconnect: boolean;
  timeout?: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface JsonRpcTransportOptions {
  command?: string;
  args?: string[];
  cwd: string;
  codexHome: string;
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RpcServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export interface JsonRpcRequestTimeout {
  timeoutMs: number;
  disconnectOnTimeout?: boolean;
  operationUncertainOnDisconnect?: boolean;
}

export type JsonRpcRequestTimeoutPolicy = number | JsonRpcRequestTimeout;

export class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export class JsonRpcMutationResponseTimeoutError extends Error {
  readonly code = "operation_uncertain";

  constructor(readonly method: string) {
    super(`Codex App Server did not confirm ${method}; the operation result is unknown and the connection is restarting`);
    this.name = "JsonRpcMutationResponseTimeoutError";
  }
}

export class JsonRpcMutationConnectionLostError extends Error {
  readonly code = "operation_uncertain";

  constructor(readonly method: string, cause: Error) {
    super(`Codex App Server disconnected before confirming ${method}; the operation result is unknown`, { cause });
    this.name = "JsonRpcMutationConnectionLostError";
  }
}

const retryableReadMethods = new Set([
  "account/read",
  "model/list",
  "thread/list",
  "thread/read",
  "thread/goal/get",
]);

export function isRetryableRequestError(method: string, error: unknown): boolean {
  if (!retryableReadMethods.has(method)) return false;
  if (error instanceof JsonRpcError) return error.code === -32_603 || (typeof error.code === "number" && error.code >= -32_099 && error.code <= -32_000);
  return error instanceof Error && error.message.startsWith("JSON-RPC timeout for ");
}

export function retryDelayMs(attempt: number, random = Math.random()): number {
  return Math.min(1_500, 80 * 2 ** attempt) + Math.round(random * 80);
}

export class JsonRpcTransport extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = true;

  constructor(private readonly options: JsonRpcTransportOptions) {
    super();
  }

  get connected(): boolean {
    return !this.closed && this.child !== null;
  }

  start(): void {
    if (this.child) return;
    const command = this.options.command ?? "codex";
    const args = this.options.args ?? ["app-server", "--stdio"];
    this.closed = false;
    this.child = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env, CODEX_HOME: this.options.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString("utf8")));
    this.watchStdinErrors(this.child);
    this.child.once("error", (error) => this.closeWithError(error));
    this.child.once("close", (code, signal) => {
      this.closeWithError(new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`));
      this.emit("exit", { code, signal });
    });
  }

  async request<TResult>(method: string, params?: unknown, timeoutPolicy?: JsonRpcRequestTimeoutPolicy): Promise<TResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce<TResult>(method, params, timeoutPolicy);
      } catch (error) {
        if (attempt >= 2 || !this.connected || !isRetryableRequestError(method, error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      }
    }
  }

  private requestOnce<TResult>(method: string, params?: unknown, timeoutPolicy?: JsonRpcRequestTimeoutPolicy): Promise<TResult> {
    if (!this.child || this.closed) throw new Error("codex app-server is not connected");
    const id = this.nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };
    return new Promise<TResult>((resolve, reject) => {
      const configuredTimeout = typeof timeoutPolicy === "object" && timeoutPolicy !== null
        ? timeoutPolicy.timeoutMs
        : timeoutPolicy;
      const effectiveTimeoutMs = configuredTimeout ?? this.options.requestTimeoutMs ?? 30_000;
      const disconnectOnTimeout = typeof timeoutPolicy === "object"
        && timeoutPolicy !== null
        && timeoutPolicy.disconnectOnTimeout === true;
      const operationUncertainOnDisconnect = typeof timeoutPolicy === "object"
        && timeoutPolicy !== null
        && timeoutPolicy.operationUncertainOnDisconnect === true;
      const pending: PendingRequest = {
        method,
        operationUncertainOnDisconnect,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      pending.timeout = setTimeout(() => {
        if (disconnectOnTimeout) {
          this.disconnectWithError(new JsonRpcMutationResponseTimeoutError(method));
          return;
        }
        this.pending.delete(id);
        reject(new Error(`JSON-RPC timeout for ${method}`));
      }, effectiveTimeoutMs);
      this.pending.set(id, pending);
      try {
        this.write(payload);
      } catch (error) {
        this.disconnectWithError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: string | number, code: number, message: string, data?: unknown): void {
    this.write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  stop(): void {
    const child = this.child;
    const wasConnected = !this.closed && child !== null;
    this.child = null;
    this.closed = true;
    if (wasConnected) this.emit("disconnecting", { reason: "stopped" });
    if (child) this.terminateChild(child);
    this.rejectAll(new Error("codex app-server stopped"));
  }

  private write(payload: unknown): void {
    if (!this.child || this.closed) throw new Error("codex app-server is not connected");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private watchStdinErrors(child: ChildProcessWithoutNullStreams): void {
    child.stdin.once("error", (error) => {
      if (this.child !== child) return;
      this.disconnectWithError(error);
    });
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error("Invalid JSON from codex app-server"), line);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.emit("protocolError", new Error("Invalid JSON-RPC message from codex app-server"), line);
      return;
    }
    const message = parsed as Record<string, unknown>;

    if ("id" in message && !("method" in message)) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      if (pending.timeout) clearTimeout(pending.timeout);
      this.pending.delete(id);
      if (message.error && typeof message.error === "object") {
        const error = message.error as { code?: number; message?: string; data?: unknown };
        pending.reject(new JsonRpcError(error.message ?? `${pending.method} failed`, error.code, error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string") {
      if ("id" in message) {
        this.emit("serverRequest", {
          id: message.id as string | number,
          method: message.method,
          params: message.params,
        } satisfies RpcServerRequest);
      } else {
        this.emit("notification", { method: message.method, params: message.params });
      }
    }
  }

  private closeWithError(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.child = null;
    this.rejectAll(error);
  }

  private disconnectWithError(error: Error): void {
    if (this.closed) return;
    const child = this.child;
    this.closed = true;
    this.child = null;
    this.emit("disconnecting", { error });
    this.rejectAll(error);
    if (child) this.terminateChild(child);
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.killed) child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2_000);
    forceKill.unref();
    child.once("close", () => clearTimeout(forceKill));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(this.disconnectErrorFor(pending, error));
    }
    this.pending.clear();
  }

  private disconnectErrorFor(pending: PendingRequest, error: Error): Error {
    if (!pending.operationUncertainOnDisconnect) return error;
    if (error instanceof JsonRpcMutationResponseTimeoutError && error.method === pending.method) return error;
    if (error instanceof JsonRpcMutationConnectionLostError && error.method === pending.method) return error;
    return new JsonRpcMutationConnectionLostError(pending.method, error);
  }
}
