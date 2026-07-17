import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { JsonRpcTransport, type JsonRpcTransportOptions } from "./json-rpc-transport.js";

export class CodexProcessSupervisor extends EventEmitter {
  private transportValue: JsonRpcTransport | null = null;
  private stopping = false;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: JsonRpcTransportOptions) {
    super();
  }

  get transport(): JsonRpcTransport {
    if (!this.transportValue) throw new Error("codex app-server has not started");
    return this.transportValue;
  }

  async start(): Promise<JsonRpcTransport> {
    this.stopping = false;
    await mkdir(this.options.codexHome, { recursive: true, mode: 0o700 });
    return this.spawn();
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.transportValue?.stop();
    this.transportValue = null;
  }

  markReady(): void {
    this.restartAttempt = 0;
  }

  retryCurrent(): void {
    if (this.stopping) return;
    if (this.transportValue) this.transportValue.stop();
    else this.scheduleRestart();
  }

  private spawn(): JsonRpcTransport {
    const transport = new JsonRpcTransport(this.options);
    this.transportValue = transport;
    transport.on("notification", (value) => this.emit("notification", value));
    transport.on("serverRequest", (value) => this.emit("serverRequest", value));
    transport.on("stderr", (value) => this.emit("stderr", value));
    transport.on("protocolError", (error, line) => this.emit("protocolError", error, line));
    transport.once("exit", (details) => {
      if (this.transportValue === transport) this.transportValue = null;
      this.emit("disconnected", details);
      if (!this.stopping) this.scheduleRestart();
    });
    transport.start();
    return transport;
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping) return;
    const delay = Math.min(30_000, 500 * 2 ** this.restartAttempt) + Math.round(Math.random() * 250);
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      const transport = this.spawn();
      this.emit("restart", transport);
    }, delay);
  }
}
