import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  readCompleteFileTail,
  type AcknowledgedCanonicalEventSink,
  type FileTailCursor,
} from "../../adapter-runtime/src/index.ts";
import { identityFromTranscriptPath, parseAntigravityRecords } from "./loader.ts";
import { mapAntigravityRecords } from "./mapper.ts";
import type {
  AntigravityDiagnostic,
  AntigravitySessionIdentity,
  PendingAntigravityTool,
} from "./types.ts";

interface AntigravityPassiveState {
  schemaVersion: 1;
  transcriptPath: string;
  sourceId: string;
  identity: AntigravitySessionIdentity;
  cursor: FileTailCursor;
  pendingTools: PendingAntigravityTool[];
  activeActivationId?: string;
}

export interface AntigravityPassiveObserverOptions {
  statePath: string;
  sourceId?: string;
  pollMs?: number;
  ackTimeoutMs?: number;
  onDiagnostic?: (diagnostic: AntigravityDiagnostic) => void;
}

export interface AntigravityPassiveScanResult {
  changed: boolean;
  emittedEvents: number;
  sessionId: string;
}

export class AntigravityPassiveObserver {
  private readonly transcriptPath: string;
  private readonly sink: AcknowledgedCanonicalEventSink;
  private readonly options: AntigravityPassiveObserverOptions;
  private state?: AntigravityPassiveState;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private scanTail: Promise<unknown> = Promise.resolve();

  constructor(
    transcriptPath: string,
    sink: AcknowledgedCanonicalEventSink,
    options: AntigravityPassiveObserverOptions,
  ) {
    this.transcriptPath = resolve(transcriptPath);
    this.sink = sink;
    this.options = options;
  }

  async start(): Promise<AntigravityPassiveScanResult> {
    if (this.timer) return this.scanOnce();
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.scanOnce().catch((cause: unknown) => this.report({
        level: "error",
        code: "antigravity-passive-scan-failed",
        location: this.transcriptPath,
        message: String(cause),
      }));
    }, this.options.pollMs ?? 350);
    this.timer.unref();
    return this.scanOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.scanTail.catch(() => undefined);
  }

  scanOnce(): Promise<AntigravityPassiveScanResult> {
    const scan = this.scanTail.then(() => this.scan(), () => this.scan());
    this.scanTail = scan.catch(() => undefined);
    return scan;
  }

  private async scan(): Promise<AntigravityPassiveScanResult> {
    if (this.stopped) throw new Error("Antigravity passive observer is stopped");
    let state = await this.ensureState();
    let tail = await readCompleteFileTail(this.transcriptPath, state.cursor);
    if (tail.reset) {
      state = await this.freshState();
      tail = await readCompleteFileTail(this.transcriptPath);
    }
    if (!tail.text) {
      return { changed: tail.changed, emittedEvents: 0, sessionId: state.identity.sessionId };
    }
    const diagnostics: AntigravityDiagnostic[] = [];
    const records = parseAntigravityRecords(
      tail.text,
      this.transcriptPath,
      tail.startLine,
      diagnostics,
    );
    for (const diagnostic of diagnostics) this.report(diagnostic);
    const mapped = mapAntigravityRecords(records, {
      sourceId: state.sourceId,
      identity: state.identity,
      pendingTools: state.pendingTools,
      activeActivationId: state.activeActivationId,
    });
    for (const event of mapped.events) await this.sink.write(event);
    if (mapped.events.length > 0) await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);

    const next: AntigravityPassiveState = {
      ...state,
      cursor: tail.cursor,
      pendingTools: mapped.pendingTools,
      ...(mapped.activeActivationId
        ? { activeActivationId: mapped.activeActivationId }
        : { activeActivationId: undefined }),
    };
    await saveState(this.options.statePath, next);
    this.state = next;
    return {
      changed: true,
      emittedEvents: mapped.events.length,
      sessionId: state.identity.sessionId,
    };
  }

  private async ensureState(): Promise<AntigravityPassiveState> {
    if (this.state) return this.state;
    const metadata = await stat(this.transcriptPath);
    const identity = `${metadata.dev}:${metadata.ino}`;
    try {
      const value: unknown = JSON.parse(await readFile(this.options.statePath, "utf8"));
      if (isState(value)
        && value.transcriptPath === this.transcriptPath
        && value.cursor.identity === identity) {
        this.state = value;
        return value;
      }
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT" && !(cause instanceof SyntaxError)) {
        throw cause;
      }
    }
    return this.freshState();
  }

  private async freshState(): Promise<AntigravityPassiveState> {
    const metadata = await stat(this.transcriptPath);
    const state: AntigravityPassiveState = {
      schemaVersion: 1,
      transcriptPath: this.transcriptPath,
      sourceId: this.options.sourceId ?? "antigravity-cli-local",
      identity: identityFromTranscriptPath(this.transcriptPath),
      cursor: {
        path: this.transcriptPath,
        identity: `${metadata.dev}:${metadata.ino}`,
        offset: 0,
        nextLine: 1,
        mtimeMs: metadata.mtimeMs,
      },
      pendingTools: [],
    };
    this.state = state;
    return state;
  }

  private report(diagnostic: AntigravityDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }
}

async function saveState(path: string, state: AntigravityPassiveState): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, absolute);
}

function isState(value: unknown): value is AntigravityPassiveState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<AntigravityPassiveState>;
  return state.schemaVersion === 1
    && typeof state.transcriptPath === "string"
    && typeof state.sourceId === "string"
    && Boolean(state.identity && typeof state.identity.sessionId === "string")
    && Boolean(state.cursor && typeof state.cursor.identity === "string")
    && Array.isArray(state.pendingTools);
}
