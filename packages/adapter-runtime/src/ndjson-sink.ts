import net from "node:net";

import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";

export interface AdapterDiagnostic {
  level: "warning" | "error";
  message: string;
  cause?: unknown;
}

export interface CanonicalEventSink {
  write(event: CanonicalEvent): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface AcknowledgedCanonicalEventSink extends CanonicalEventSink {
  whenIdle(timeoutMs?: number): Promise<void>;
}

export interface NdjsonTcpSinkOptions {
  token: string;
  host?: string;
  port?: number;
  maxQueue?: number;
  maxInFlight?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  onDiagnostic?: (diagnostic: AdapterDiagnostic) => void;
  socketFactory?: (options: { host: string; port: number }) => NdjsonSocket;
}

export interface NdjsonSocket {
  readyState: string;
  setNoDelay(value?: boolean): this;
  setEncoding(encoding: BufferEncoding): this;
  on(event: string, listener: (...args: never[]) => void): this;
  once(event: string, listener: (...args: never[]) => void): this;
  write(data: string): boolean;
  destroy(): this;
}

/** Loopback NDJSON transport with bounded pipelining and replay on reconnect. */
export class NdjsonTcpSink implements AcknowledgedCanonicalEventSink {
  private readonly host: string;
  private readonly port: number;
  private readonly maxQueue: number;
  private readonly maxInFlight: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly queue: CanonicalEvent[] = [];
  private socket?: NdjsonSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private retryMs: number;
  private incoming = "";
  private readonly inFlight: string[] = [];
  private writable = true;
  private closed = false;
  private readonly options: NdjsonTcpSinkOptions;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(options: NdjsonTcpSinkOptions) {
    this.options = options;
    if (!options.token.trim()) throw new Error("Orchetrace ingest token must not be empty");
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 43117;
    this.maxQueue = options.maxQueue ?? 50_000;
    this.maxInFlight = options.maxInFlight ?? 32;
    if (!Number.isSafeInteger(this.maxInFlight) || this.maxInFlight <= 0) {
      throw new Error("Orchetrace maxInFlight must be a positive safe integer");
    }
    this.reconnectMinMs = options.reconnectMinMs ?? 250;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
    this.retryMs = this.reconnectMinMs;
    this.connect();
  }

  write(event: CanonicalEvent): void {
    if (this.closed) throw new Error("Orchetrace sink is closed");
    if (this.queue.length >= this.maxQueue) {
      throw new Error(`Orchetrace transport queue reached ${this.maxQueue} events`);
    }
    this.queue.push(event);
    this.flush();
  }

  async close(): Promise<void> {
    await this.whenIdle(3_000).catch(() => undefined);
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = undefined;
  }

  whenIdle(timeoutMs = 10_000): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.idleWaiters.indexOf(done);
        if (index >= 0) this.idleWaiters.splice(index, 1);
        reject(new Error(`Orchetrace transport did not drain within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.idleWaiters.push(done);
    });
  }

  private connect(): void {
    if (this.closed || this.socket) return;
    const socket = this.options.socketFactory?.({ host: this.host, port: this.port })
      ?? net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      this.retryMs = this.reconnectMinMs;
      this.writable = socket.write(`${JSON.stringify({ kind: "hello", protocol: 1, token: this.options.token })}\n`);
      this.options.onDiagnostic?.({ level: "warning", message: "transport connected" });
      this.flush();
    });
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("drain", () => {
      this.writable = true;
      this.flush();
    });
    socket.once("error", (cause) => {
      this.options.onDiagnostic?.({ level: "warning", message: "transport unavailable", cause });
    });
    socket.once("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.inFlight.splice(0);
      this.incoming = "";
      this.writable = true;
      this.scheduleReconnect();
    });
  }

  private receive(chunk: string): void {
    this.incoming += chunk;
    while (true) {
      const newline = this.incoming.indexOf("\n");
      if (newline < 0) return;
      const line = this.incoming.slice(0, newline).trim();
      this.incoming = this.incoming.slice(newline + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line) as { kind?: string; event_id?: string; message?: string };
        if (frame.kind === "ack" && frame.event_id === this.inFlight[0]) {
          if (this.queue[0]?.event_id === frame.event_id) this.queue.shift();
          this.inFlight.shift();
          if (this.queue.length === 0) {
            for (const resolve of this.idleWaiters.splice(0)) resolve();
          }
          this.flush();
        } else if (frame.kind === "ack") {
          this.options.onDiagnostic?.({
            level: "error",
            message: `unexpected ingest acknowledgement ${frame.event_id ?? "<missing>"}`,
          });
          this.socket?.destroy();
        } else if (frame.kind === "error") {
          this.options.onDiagnostic?.({ level: "error", message: frame.message ?? "ingest rejected frame" });
          this.socket?.destroy();
        }
      } catch (cause: unknown) {
        this.options.onDiagnostic?.({ level: "error", message: "invalid ingest response", cause });
      }
    }
  }

  private flush(): void {
    if (!this.socket?.readyState || this.socket.readyState !== "open" || !this.writable) return;
    while (this.inFlight.length < this.maxInFlight && this.writable) {
      const event = this.queue[this.inFlight.length];
      if (!event) return;
      this.inFlight.push(event.event_id);
      this.writable = this.socket.write(`${JSON.stringify(event)}\n`);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    // This timer intentionally stays referenced. Adapter CLIs may have only
    // unref'ed discovery timers, so an initial desktop startup race must not
    // let Node exit before the Rust ingest socket becomes ready.
  }
}
