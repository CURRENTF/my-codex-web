import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { findPackageJSON } from "node:module";
import path from "node:path";

/** Pi uses JSONL records, not Codex JSON-RPC. Keep each conversation in its own process. */
export class PiRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private sequence = 0;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private closing = false;
  constructor(private readonly cwd: string, private readonly args: string[], private readonly command?: string) { super(); }
  start(): void {
    const cli = this.command ? "" : path.join(path.dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!), "dist/bundle/cli.js");
    this.child = spawn(this.command || process.execPath, [...(this.command ? [] : [cli]), "--mode", "rpc", ...this.args], {
      cwd: this.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) { this.fail(new Error("Pi RPC record exceeds 32 MiB")); this.stop(); return; }
      let boundary: number;
      while ((boundary = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, boundary).trim(); this.buffer = this.buffer.slice(boundary + 1);
        if (!line) continue;
        let record: any;
        try { record = JSON.parse(line); } catch { this.fail(new Error("Pi returned an invalid JSONL record")); this.stop(); return; }
        if (record.type === "response") {
          const pending = this.pending.get(record.id);
          if (!pending) continue;
          this.pending.delete(record.id); clearTimeout(pending.timer);
          if (record.success) pending.resolve(record.data);
          else pending.reject(new Error(typeof record.error === "string" ? record.error : "Pi command failed"));
        } else this.emit("record", record);
      }
    });
    // Drain diagnostics, but do not forward potentially credential-bearing provider output.
    this.child.stderr.resume();
    this.child.on("error", (error) => this.fail(new Error(`Unable to start Pi: ${error.message}`)));
    this.child.stdin.on("error", () => this.fail(new Error("Pi input connection closed")));
    this.child.on("exit", (code, signal) => {
      this.child = null;
      this.fail(new Error(`Pi process exited (${signal ?? code ?? "unknown"})`));
    });
  }
  request(type: string, data: Record<string, unknown> = {}, timeout = 30_000): Promise<any> {
    if (!this.child || this.closing) return Promise.reject(new Error("Pi process is not running"));
    const id = `web-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Pi ${type} timed out; the operation may have been accepted. Refresh before retrying.`);
        reject(error); this.fail(error);
        // An unresponsive process must not continue a hidden run after the UI reports failure.
        this.stop();
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ ...data, type, id })}\n`);
    });
  }
  send(record: Record<string, unknown>): void { this.child?.stdin.write(`${JSON.stringify(record)}\n`); }
  stop(): void {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end(); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500); timer.unref();
    child.once("exit", () => clearTimeout(timer));
    this.rejectPending(new Error("Pi process stopped"));
  }
  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  private fail(error: Error): void {
    this.rejectPending(error);
    if (!this.closing) this.emit("failure", error);
  }
}
