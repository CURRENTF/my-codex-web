import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

interface PendingRequest {
  method: string;
  timeout: NodeJS.Timeout;
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

export class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
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
    this.child.once("error", (error) => this.closeWithError(error));
    this.child.once("close", (code, signal) => {
      this.closeWithError(new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`));
      this.emit("exit", { code, signal });
    });
  }

  async request<TResult>(method: string, params?: unknown, timeoutMs?: number): Promise<TResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce<TResult>(method, params, timeoutMs);
      } catch (error) {
        if (attempt >= 2 || !this.connected || !isRetryableRequestError(method, error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      }
    }
  }

  private requestOnce<TResult>(method: string, params?: unknown, timeoutMs?: number): Promise<TResult> {
    if (!this.child || this.closed) throw new Error("codex app-server is not connected");
    const id = this.nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };
    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC timeout for ${method}`));
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { method, timeout, resolve: resolve as (value: unknown) => void, reject });
      this.write(payload);
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
    this.child = null;
    this.closed = true;
    if (child && !child.killed) child.kill("SIGTERM");
    this.rejectAll(new Error("codex app-server stopped"));
  }

  private write(payload: unknown): void {
    if (!this.child || this.closed) throw new Error("codex app-server is not connected");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit("protocolError", new Error("Invalid JSON from codex app-server"), line);
      return;
    }

    if ("id" in message && !("method" in message)) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
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

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
