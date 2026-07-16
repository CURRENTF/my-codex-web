import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { UiEvent } from "@codex-web/shared-types";

export class EventGateway extends EventEmitter {
  private readonly server = new WebSocketServer({ noServer: true });
  private seq = 0;

  constructor(private readonly authenticate: (request: IncomingMessage) => boolean) {
    super();
    this.server.on("connection", (socket) => {
      socket.send(JSON.stringify(this.event("connection.ready", { connected: true })));
    });
  }

  handleUpgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    if (!this.authenticate(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    this.server.handleUpgrade(request, socket, head, (webSocket) => this.server.emit("connection", webSocket, request));
  }

  publish(type: string, payload: unknown, ids: { threadId?: string; sideChatId?: string } = {}): UiEvent {
    const event = this.event(type, payload, ids);
    const data = JSON.stringify(event);
    for (const client of this.server.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
    this.emit("event", event);
    return event;
  }

  close(): void {
    for (const client of this.server.clients) client.close(1001, "Server shutting down");
    this.server.close();
  }

  private event(type: string, payload: unknown, ids: { threadId?: string; sideChatId?: string } = {}): UiEvent {
    return { seq: ++this.seq, type, emittedAt: Date.now(), payload, ...ids };
  }
}
