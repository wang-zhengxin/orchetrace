import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import { identityFromSessionMeta, mapCodexRecord } from "./mapper.ts";
import { parseCodexRecords, sourceIdFor } from "./loader.ts";
import type { CodexDiagnostic, CodexSessionIdentity } from "./types.ts";

interface CodexPassiveState {
  schemaVersion: 2;
  transcriptPath: string;
  sourceId: string;
  identity: CodexSessionIdentity;
  headerLine: number;
  fileIdentity: string;
  offset: number;
  nextLine: number;
}

export interface CodexPassiveObserverOptions {
  statePath: string;
  sourceId?: string;
  pollMs?: number;
  ackTimeoutMs?: number;
  onDiagnostic?: (diagnostic: CodexDiagnostic) => void;
}

export interface CodexPassiveScanResult {
  changed: boolean;
  emittedEvents: number;
  sessionId: string;
}

/** Incrementally tails one persisted Codex rollout and commits its byte cursor only after ACK. */
export class CodexPassiveObserver {
  private readonly transcriptPath: string;
  private readonly sink: AcknowledgedCanonicalEventSink;
  private readonly options: CodexPassiveObserverOptions;
  private state?: CodexPassiveState;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private scanTail: Promise<unknown> = Promise.resolve();

  constructor(
    transcriptPath: string,
    sink: AcknowledgedCanonicalEventSink,
    options: CodexPassiveObserverOptions,
  ) {
    this.transcriptPath = resolve(transcriptPath);
    this.sink = sink;
    this.options = options;
  }

  async start(): Promise<CodexPassiveScanResult> {
    if (this.timer) return this.scanOnce();
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.scanOnce().catch((cause: unknown) => this.report({
        level: "error",
        code: "codex-passive-scan-failed",
        location: this.transcriptPath,
        message: String(cause),
      }));
    }, this.options.pollMs ?? 400);
    this.timer.unref();
    return this.scanOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.scanTail.catch(() => undefined);
  }

  scanOnce(): Promise<CodexPassiveScanResult> {
    const scan = this.scanTail.then(() => this.scan(), () => this.scan());
    this.scanTail = scan.catch(() => undefined);
    return scan;
  }

  private async scan(): Promise<CodexPassiveScanResult> {
    if (this.stopped) throw new Error("Codex passive observer is stopped");
    let state = await this.ensureState();
    const metadata = await stat(this.transcriptPath);
    const identity = `${metadata.dev}:${metadata.ino}`;
    if (identity !== state.fileIdentity || metadata.size < state.offset) {
      state = await this.freshState(identity);
    }
    if (metadata.size === state.offset) {
      return { changed: false, emittedEvents: 0, sessionId: state.identity.sessionId };
    }

    const handle = await open(this.transcriptPath, "r");
    let bytes: Buffer;
    try {
      const length = metadata.size - state.offset;
      bytes = Buffer.alloc(length);
      const result = await handle.read(bytes, 0, length, state.offset);
      bytes = bytes.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return { changed: false, emittedEvents: 0, sessionId: state.identity.sessionId };
    }

    const consumed = bytes.subarray(0, lastNewline + 1);
    const text = consumed.toString("utf8");
    const diagnostics: CodexDiagnostic[] = [];
    const records = parseCodexRecords(text, this.transcriptPath, state.nextLine, diagnostics);
    for (const diagnostic of diagnostics) this.report(diagnostic);
    const events = records.flatMap((record) => mapCodexRecord(record, {
      sourceId: state.sourceId,
      identity: state.identity,
      headerLine: state.headerLine,
    }));
    for (const event of events) await this.sink.write(event);
    if (events.length > 0) await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);

    const next: CodexPassiveState = {
      ...state,
      offset: state.offset + consumed.length,
      nextLine: state.nextLine + countNewlines(consumed),
    };
    await saveState(this.options.statePath, next);
    this.state = next;
    return { changed: true, emittedEvents: events.length, sessionId: state.identity.sessionId };
  }

  private async ensureState(): Promise<CodexPassiveState> {
    if (this.state) return this.state;
    const metadata = await stat(this.transcriptPath);
    const fileIdentity = `${metadata.dev}:${metadata.ino}`;
    try {
      const value: unknown = JSON.parse(await readFile(this.options.statePath, "utf8"));
      if (isState(value) && value.transcriptPath === this.transcriptPath && value.fileIdentity === fileIdentity) {
        this.state = value;
        return value;
      }
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT" && !(cause instanceof SyntaxError)) throw cause;
    }
    return this.freshState(fileIdentity);
  }

  private async freshState(fileIdentity: string): Promise<CodexPassiveState> {
    const header = await readIdentity(this.transcriptPath);
    const identity = header.identity;
    const state: CodexPassiveState = {
      schemaVersion: 2,
      transcriptPath: this.transcriptPath,
      sourceId: this.options.sourceId ?? sourceIdFor(identity.cwd ?? identity.sessionId),
      identity,
      headerLine: header.line,
      fileIdentity,
      offset: 0,
      nextLine: 1,
    };
    this.state = state;
    return state;
  }

  private report(diagnostic: CodexDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }
}

async function readIdentity(path: string): Promise<{ identity: CodexSessionIdentity; line: number }> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    const diagnostics: CodexDiagnostic[] = [];
    const records = parseCodexRecords(buffer.subarray(0, result.bytesRead).toString("utf8"), path, 1, diagnostics);
    const header = records
      .filter((record) => record.type === "session_meta")
      .map((record) => ({ record, identity: identityFromSessionMeta(record.payload) }))
      .find((value): value is { record: (typeof records)[number]; identity: CodexSessionIdentity } => Boolean(value.identity));
    if (!header) throw new Error(`Codex rollout has no session_meta in its first MiB: ${path}`);
    return { identity: header.identity, line: header.record.line };
  } finally {
    await handle.close();
  }
}

function countNewlines(bytes: Buffer): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count;
}

function isState(value: unknown): value is CodexPassiveState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<CodexPassiveState>;
  return state.schemaVersion === 2
    && typeof state.transcriptPath === "string"
    && typeof state.sourceId === "string"
    && typeof state.fileIdentity === "string"
    && Number.isInteger(state.offset) && (state.offset ?? -1) >= 0
    && Number.isInteger(state.nextLine) && (state.nextLine ?? 0) > 0
    && Number.isInteger(state.headerLine) && (state.headerLine ?? 0) > 0
    && Boolean(state.identity)
    && typeof state.identity?.sessionId === "string";
}

async function saveState(path: string, state: CodexPassiveState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
