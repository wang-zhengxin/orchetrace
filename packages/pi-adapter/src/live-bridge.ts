import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { EventEmitter } from "node:events";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import { loadPiSession, parsePiSession } from "./loader.ts";
import { PiRpcMapper } from "./rpc-mapper.ts";
import type { PiDiagnostic } from "./types.ts";

interface PiLiveState {
  schemaVersion: 1;
  transcriptPath: string;
  sourceId: string;
  sessionId: string;
  generation: number;
  activeLeafId?: string;
}

export interface PiRpcProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  pid?: number;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type PiRpcProcessFactory = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => PiRpcProcess;

export interface PiLiveBridgeOptions {
  statePath: string;
  sourceId?: string;
  sessionId?: string;
  command?: string;
  args?: string[];
  extensions?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  ackTimeoutMs?: number;
  rpcTimeoutMs?: number;
  allowPartial?: boolean;
  entryCursor?: "auto" | "required" | "disabled";
  telemetryPollMs?: number;
  processFactory?: PiRpcProcessFactory;
  onRpcResponse?: (response: Record<string, unknown>) => void;
  onDiagnostic?: (diagnostic: PiDiagnostic) => void;
}

export interface PiLiveStartResult {
  sourceId: string;
  sessionId: string;
  generation: number;
  activeLeafId?: string;
  replayEvents: number;
  catchUpEvents: number;
  cursorMode: "rpc" | "file-fallback" | "disabled";
  bufferedRpcRecords: number;
  emittedBufferedEvents: number;
}

interface BufferedRecord {
  value: unknown;
  observedAt: string;
}

interface PendingRpcRequest {
  command: string;
  resolve: (response: Record<string, unknown>) => void;
  reject: (cause: Error) => void;
  timer: NodeJS.Timeout;
}

interface FileSnapshot {
  identity: string;
  size: number;
  mtimeMs: number;
}

interface PendingTelemetryCommit {
  events: CanonicalEvent[];
  snapshot: FileSnapshot;
  activeLeafId?: string;
}

/** Owns a Pi RPC subprocess and bridges persisted history into its live lifecycle stream. */
export class PiLiveBridge {
  private readonly transcriptPath: string;
  private readonly sink: AcknowledgedCanonicalEventSink;
  private readonly options: PiLiveBridgeOptions;
  private child?: PiRpcProcess;
  private mapper?: PiRpcMapper;
  private incoming = "";
  private bootstrapping = true;
  private buffered: BufferedRecord[] = [];
  private deliveryTail: Promise<void> = Promise.resolve();
  private stopped = false;
  private bootstrapKeys = new Set<string>();
  private processFailure?: Error;
  private requestCounter = 0;
  private readonly pendingRequests = new Map<string, PendingRpcRequest>();
  private telemetryTimer?: NodeJS.Timeout;
  private telemetryScanTail: Promise<unknown> = Promise.resolve();
  private telemetrySnapshot?: FileSnapshot;
  private readonly telemetryEventIds = new Set<string>();
  private liveState?: PiLiveState;
  private pendingTelemetryCommit?: PendingTelemetryCommit;
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = Promise.resolve({
    code: null,
    signal: null,
  });

  constructor(
    transcriptPath: string,
    sink: AcknowledgedCanonicalEventSink,
    options: PiLiveBridgeOptions,
  ) {
    this.transcriptPath = resolve(transcriptPath);
    this.sink = sink;
    this.options = options;
  }

  async start(): Promise<PiLiveStartResult> {
    if (this.child) throw new Error("Pi live bridge is already started");
    this.stopped = false;
    this.bootstrapping = true;
    this.buffered = [];
    this.bootstrapKeys.clear();
    this.processFailure = undefined;
    this.requestCounter = 0;
    this.telemetryEventIds.clear();
    this.telemetrySnapshot = undefined;
    this.pendingTelemetryCommit = undefined;

    // Read identity before spawn, then read the complete file again after RPC listeners are attached.
    const identity = await parsePiSession(this.transcriptPath, this.options.sessionId);
    const sourceId = this.options.sourceId ?? `pi-${shortHash(this.transcriptPath)}`;
    const sessionId = identity.header.id;
    const state = await reserveGeneration(this.options.statePath, {
      transcriptPath: this.transcriptPath,
      sourceId,
      sessionId,
    });
    this.mapper = new PiRpcMapper({
      sourceId,
      sessionId,
      eventEpoch: state.generation,
      onDiagnostic: (diagnostic) => this.report(diagnostic),
    });

    const command = this.options.command ?? "pi";
    const args = [
      ...(this.options.args ?? ["--mode", "rpc", "--session", this.transcriptPath]),
      ...(this.options.extensions ?? []).flatMap((path) => ["--extension", path]),
    ].map((argument) => argument.replaceAll("{transcript}", this.transcriptPath));
    const factory = this.options.processFactory ?? defaultProcessFactory;
    const child = factory(command, args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.on("data", (chunk: string) =>
      this.report({
        level: "warning",
        code: "rpc-stderr",
        location: `pid:${child.pid ?? "unknown"}`,
        message: chunk.trimEnd(),
      }),
    );
    this.exitPromise = new Promise((complete) => {
      let completed = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (completed) return;
        completed = true;
        complete({ code, signal });
      };
      child.once("error", (cause: Error) => {
        this.processFailure = new Error(`cannot start Pi RPC process: ${cause.message}`, { cause });
        this.rejectPendingRequests(this.processFailure);
        this.report({
          level: "error",
          code: "rpc-process-error",
          location: command,
          message: this.processFailure.message,
        });
        finish(null, null);
      });
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        if (!this.stopped && (code !== 0 || signal)) {
          this.processFailure = new Error(
            `Pi RPC process exited with code ${String(code)} signal ${String(signal)}`,
          );
          this.rejectPendingRequests(this.processFailure);
          this.report({
            level: "error",
            code: "rpc-process-exited",
            location: `pid:${child.pid ?? "unknown"}`,
            message: this.processFailure.message,
          });
        }
        finish(code, signal);
      });
    });

    let loaded;
    let catchUpEvents = 0;
    let cursorMode: PiLiveStartResult["cursorMode"] = "disabled";
    try {
      loaded = await loadPiSession(this.transcriptPath, { sourceId, sessionId });
      for (const diagnostic of loaded.diagnostics) this.report(diagnostic);
      if (!this.options.allowPartial && loaded.diagnostics.some((item) => item.level === "error")) {
        throw new Error("Pi session contains errors; live bootstrap was not delivered");
      }
      for (const event of loaded.events) {
        this.bootstrapKeys.add(semanticKey(event));
        await this.sink.write(event);
      }
      await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);
      if (this.processFailure) throw this.processFailure;
      const caughtUp = await this.catchUpPersistedEntries(
        loaded,
        sourceId,
        sessionId,
        state.activeLeafId ?? loaded.activeLeafId,
      );
      loaded = caughtUp.loaded;
      catchUpEvents = caughtUp.emittedEvents;
      cursorMode = caughtUp.cursorMode;
    } catch (cause: unknown) {
      this.stopped = true;
      this.rejectPendingRequests(cause instanceof Error ? cause : new Error(String(cause)));
      child.kill("SIGTERM");
      this.child = undefined;
      throw cause;
    }

    const pending = this.buffered.splice(0);
    this.bootstrapping = false;
    let emittedBufferedEvents = 0;
    for (const record of pending) {
      emittedBufferedEvents += this.enqueueRecord(record, true);
    }
    await this.deliveryTail;
    await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);
    this.bootstrapKeys.clear();
    this.liveState = { ...state, activeLeafId: loaded.activeLeafId };
    await saveState(this.options.statePath, this.liveState);
    for (const event of loaded.events) {
      if (event.source_ref?.kind === "pi-telemetry-entry") this.telemetryEventIds.add(event.event_id);
    }
    if ((this.options.telemetryPollMs ?? 500) > 0) {
      await this.scanTelemetryOnce();
      this.telemetryTimer = setInterval(() => {
        void this.scanTelemetryOnce().catch((cause: unknown) =>
          this.report({
            level: "error",
            code: "telemetry-live-scan-failed",
            location: this.transcriptPath,
            message: String(cause),
          }),
        );
      }, this.options.telemetryPollMs ?? 500);
      this.telemetryTimer.unref();
    }
    return {
      sourceId,
      sessionId,
      generation: state.generation,
      activeLeafId: loaded.activeLeafId,
      replayEvents: loaded.events.length,
      catchUpEvents,
      cursorMode,
      bufferedRpcRecords: pending.length,
      emittedBufferedEvents,
    };
  }

  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exitPromise;
  }

  writeCommand(command: unknown): void {
    this.writeRaw(`${JSON.stringify(command)}\n`);
  }

  writeRaw(chunk: string | Buffer): void {
    if (!this.child || this.stopped) throw new Error("Pi live bridge is not running");
    this.child.stdin.write(chunk);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = undefined;
    const child = this.child;
    this.child = undefined;
    this.rejectPendingRequests(new Error("Pi live bridge stopped"));
    if (this.incoming.trim()) {
      this.report({
        level: "error",
        code: "rpc-frame-truncated",
        location: "rpc",
        message: "Pi RPC stdout ended with an unterminated JSONL record",
      });
    }
    await this.deliveryTail;
    await this.telemetryScanTail;
    await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);
    child?.stdin.end();
    if (child && !child.killed) child.kill("SIGTERM");
  }

  scanTelemetryOnce(): Promise<number> {
    const scan = this.telemetryScanTail.then(
      () => this.scanTelemetry(),
      () => this.scanTelemetry(),
    );
    this.telemetryScanTail = scan.catch(() => undefined);
    return scan;
  }

  private receive(chunk: string): void {
    this.incoming += chunk;
    while (true) {
      const newline = this.incoming.indexOf("\n");
      if (newline < 0) return;
      let line = this.incoming.slice(0, newline);
      this.incoming = this.incoming.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value) && value.type === "response") {
          if (!this.resolvePendingRequest(value)) this.options.onRpcResponse?.(value);
          continue;
        }
        const record = { value, observedAt: new Date().toISOString() };
        if (this.bootstrapping) this.buffered.push(record);
        else this.enqueueRecord(record, false);
      } catch (cause: unknown) {
        this.report({
          level: "error",
          code: "rpc-json-invalid",
          location: "rpc",
          message: `cannot parse Pi RPC JSONL record: ${String(cause)}`,
        });
      }
    }
  }

  private enqueueRecord(record: BufferedRecord, deduplicateBootstrap: boolean): number {
    const events = this.mapper?.map(record.value, record.observedAt) ?? [];
    const candidates = deduplicateBootstrap
      ? events.filter((event) => !this.bootstrapKeys.has(semanticKey(event)))
      : events;
    for (const event of candidates) {
      this.deliveryTail = this.deliveryTail.then(async () => {
        await this.sink.write(event);
      });
    }
    return candidates.length;
  }

  private async scanTelemetry(): Promise<number> {
    if (this.stopped) return 0;
    if (this.pendingTelemetryCommit) {
      await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);
      await this.commitTelemetry(this.pendingTelemetryCommit);
      this.pendingTelemetryCommit = undefined;
      return 0;
    }
    const metadata = await stat(this.transcriptPath);
    const snapshot: FileSnapshot = {
      identity: `${metadata.dev}:${metadata.ino}`,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
    };
    if (sameSnapshot(snapshot, this.telemetrySnapshot)) return 0;
    const loaded = await loadPiSession(this.transcriptPath, {
      sourceId: this.liveState?.sourceId ?? this.options.sourceId,
      sessionId: this.liveState?.sessionId ?? this.options.sessionId,
    });
    for (const diagnostic of loaded.diagnostics) this.report(diagnostic);
    if (!this.options.allowPartial && loaded.diagnostics.some((item) => item.level === "error")) {
      throw new Error("Pi session contains errors during telemetry live scan");
    }
    const candidates = loaded.events.filter(
      (event) =>
        event.source_ref?.kind === "pi-telemetry-entry" && !this.telemetryEventIds.has(event.event_id),
    );
    for (const event of candidates) await this.sink.write(event);
    const commit = { events: candidates, snapshot, activeLeafId: loaded.activeLeafId };
    this.pendingTelemetryCommit = commit;
    if (candidates.length > 0) await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);
    await this.commitTelemetry(commit);
    this.pendingTelemetryCommit = undefined;
    return candidates.length;
  }

  private async commitTelemetry(commit: PendingTelemetryCommit): Promise<void> {
    for (const event of commit.events) this.telemetryEventIds.add(event.event_id);
    if (this.liveState) {
      this.liveState = { ...this.liveState, activeLeafId: commit.activeLeafId };
      await saveState(this.options.statePath, this.liveState);
    }
    // Keep the pre-read metadata: an append during read remains visible to the next scan.
    this.telemetrySnapshot = commit.snapshot;
  }

  private async catchUpPersistedEntries(
    initial: Awaited<ReturnType<typeof loadPiSession>>,
    sourceId: string,
    sessionId: string,
    cursor?: string,
  ): Promise<{
    loaded: Awaited<ReturnType<typeof loadPiSession>>;
    emittedEvents: number;
    cursorMode: PiLiveStartResult["cursorMode"];
  }> {
    const policy = this.options.entryCursor ?? "auto";
    if (policy === "disabled") return { loaded: initial, emittedEvents: 0, cursorMode: "disabled" };
    let response: Record<string, unknown> | undefined;
    try {
      response = await this.requestRpc({
        type: "get_entries",
        ...(cursor ? { since: cursor } : {}),
      });
    } catch (cause: unknown) {
      if (policy === "required") throw cause;
      this.report({
        level: "warning",
        code: "rpc-entry-cursor-unavailable",
        location: "rpc:get_entries",
        message: `Pi RPC entry cursor unavailable; using file fallback: ${String(cause)}`,
      });
    }

    if (response && response.success !== true) {
      const message = rpcError(response);
      if (message.toLowerCase().includes("unknown command")) {
        if (policy === "required") throw new Error(`Pi RPC get_entries failed: ${message}`);
        this.report({
          level: "warning",
          code: "rpc-entry-cursor-unsupported",
          location: "rpc:get_entries",
          message: `Pi RPC does not support get_entries; using file fallback: ${message}`,
        });
        response = undefined;
      } else if (cursor) {
        this.report({
          level: "warning",
          code: "rpc-entry-cursor-reset",
          location: "rpc:get_entries",
          message: `Pi RPC rejected saved entry cursor; requesting a full high-water: ${message}`,
        });
        response = await this.requestRpc({ type: "get_entries" });
        if (response.success !== true) throw new Error(`Pi RPC full get_entries failed: ${rpcError(response)}`);
      } else if (policy === "required") {
        throw new Error(`Pi RPC get_entries failed: ${message}`);
      } else {
        response = undefined;
      }
    }

    const supported = response?.success === true;
    const reloaded = await loadPiSession(this.transcriptPath, { sourceId, sessionId });
    for (const diagnostic of reloaded.diagnostics) this.report(diagnostic);
    if (!this.options.allowPartial && reloaded.diagnostics.some((item) => item.level === "error")) {
      throw new Error("Pi session contains errors during entry cursor catch-up");
    }
    if (supported) {
      const data = isRecord(response?.data) ? response.data : undefined;
      const leafId = data?.leafId;
      if (leafId !== null && typeof leafId !== "string") {
        throw new Error("Pi RPC get_entries response requires data.leafId as string or null");
      }
      if ((leafId ?? undefined) !== reloaded.activeLeafId) {
        throw new Error(
          `Pi RPC/file leaf mismatch: RPC=${String(leafId)} file=${String(reloaded.activeLeafId)}`,
        );
      }
    }

    const existingIds = new Set(initial.events.map((event) => event.event_id));
    const candidates = reloaded.events.filter((event) => !existingIds.has(event.event_id));
    for (const event of candidates) {
      this.bootstrapKeys.add(semanticKey(event));
      await this.sink.write(event);
    }
    if (candidates.length > 0) await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);
    return {
      loaded: reloaded,
      emittedEvents: candidates.length,
      cursorMode: supported ? "rpc" : "file-fallback",
    };
  }

  private requestRpc(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    const type = typeof command.type === "string" ? command.type : "unknown";
    const id = `orchetrace:${this.options.sourceId ?? "pi"}:${this.requestCounter}`;
    this.requestCounter += 1;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectRequest(new Error(`Pi RPC ${type} timed out after ${this.options.rpcTimeoutMs ?? 5_000}ms`));
      }, this.options.rpcTimeoutMs ?? 5_000);
      this.pendingRequests.set(id, { command: type, resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        this.writeCommand({ ...command, id });
      } catch (cause: unknown) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        rejectRequest(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  private resolvePendingRequest(response: Record<string, unknown>): boolean {
    const id = typeof response.id === "string" ? response.id : undefined;
    let match = id ? this.pendingRequests.get(id) : undefined;
    let matchId = id;
    if (!match && typeof response.command === "string") {
      const matches = [...this.pendingRequests.entries()].filter(([, pending]) => pending.command === response.command);
      if (matches.length === 1) [matchId, match] = matches[0];
    }
    if (!match || !matchId) return false;
    clearTimeout(match.timer);
    this.pendingRequests.delete(matchId);
    match.resolve(response);
    return true;
  }

  private rejectPendingRequests(cause: Error): void {
    for (const request of this.pendingRequests.values()) {
      clearTimeout(request.timer);
      request.reject(cause);
    }
    this.pendingRequests.clear();
  }

  private report(diagnostic: PiDiagnostic): void {
    if (diagnostic.code === "rpc-stderr" && !diagnostic.message) return;
    this.options.onDiagnostic?.(diagnostic);
  }
}

function semanticKey(event: CanonicalEvent): string {
  const data = event.data as Record<string, unknown>;
  if (event.type === "tool.started" || event.type === "tool.finished") {
    return `${event.type}:${String(data.call_id ?? "")}`;
  }
  if (event.type === "prompt.accepted") {
    return `${event.type}:${event.occurred_at}:${String(data.excerpt ?? "")}`;
  }
  if (event.type === "assistant.message" || event.type === "assistant.reasoning_summary") {
    return `${event.type}:${event.occurred_at}:${String(data.summary ?? "")}`;
  }
  if (event.type === "context.compacted") {
    return `${event.type}:${String(data.first_kept_entry_id ?? "")}:${String(data.summary ?? "")}`;
  }
  return `event:${event.event_id}`;
}

async function reserveGeneration(
  statePath: string,
  identity: Pick<PiLiveState, "transcriptPath" | "sourceId" | "sessionId">,
): Promise<PiLiveState> {
  let generation = 0;
  let activeLeafId: string | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (!isState(parsed)) throw new Error("unsupported or malformed Pi live state");
    if (
      parsed.transcriptPath !== identity.transcriptPath ||
      parsed.sourceId !== identity.sourceId ||
      parsed.sessionId !== identity.sessionId
    ) {
      throw new Error("Pi live state belongs to a different transcript, source, or session");
    }
    generation = parsed.generation;
    activeLeafId = parsed.activeLeafId;
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const state: PiLiveState = { schemaVersion: 1, ...identity, generation: generation + 1, activeLeafId };
  // Reserve before spawning: a crash may leave a harmless gap, never a reused RPC event namespace.
  await saveState(statePath, state);
  return state;
}

async function saveState(path: string, state: PiLiveState): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, absolute);
}

function isState(value: unknown): value is PiLiveState {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.transcriptPath === "string" &&
    typeof value.sourceId === "string" &&
    typeof value.sessionId === "string" &&
    Number.isInteger(value.generation) &&
    Number(value.generation) >= 0 &&
    (value.activeLeafId === undefined || typeof value.activeLeafId === "string")
  );
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function defaultProcessFactory(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  return spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rpcError(response: Record<string, unknown>): string {
  if (typeof response.error === "string") return response.error;
  if (typeof response.message === "string") return response.message;
  return `${String(response.command ?? "RPC command")} was rejected`;
}

function sameSnapshot(left: FileSnapshot, right?: FileSnapshot): boolean {
  return Boolean(
    right &&
      left.identity === right.identity &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs,
  );
}
