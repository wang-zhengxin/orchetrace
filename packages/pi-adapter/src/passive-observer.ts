import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import { loadPiSession, parsePiSession } from "./loader.ts";
import type { PiDiagnostic } from "./types.ts";

interface FileSnapshot {
  identity: string;
  size: number;
  mtimeMs: number;
}

interface PiPassiveState {
  schemaVersion: 1;
  transcriptPath: string;
  sourceId: string;
  sessionId: string;
  file?: FileSnapshot;
  eventIds: string[];
}

interface PendingCommit {
  state: PiPassiveState;
  emittedEvents: number;
}

export interface PiPassiveObserverOptions {
  statePath: string;
  sourceId?: string;
  pollMs?: number;
  ackTimeoutMs?: number;
  allowPartial?: boolean;
  onDiagnostic?: (diagnostic: PiDiagnostic) => void;
}

export interface PiPassiveScanResult {
  changed: boolean;
  emittedEvents: number;
  sessionId: string;
}

/** Passively follows an already-running Pi session without spawning a second Pi process. */
export class PiPassiveObserver {
  private readonly transcriptPath: string;
  private readonly sink: AcknowledgedCanonicalEventSink;
  private readonly options: PiPassiveObserverOptions;
  private state?: PiPassiveState;
  private pendingCommit?: PendingCommit;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private scanTail: Promise<unknown> = Promise.resolve();

  constructor(
    transcriptPath: string,
    sink: AcknowledgedCanonicalEventSink,
    options: PiPassiveObserverOptions,
  ) {
    this.transcriptPath = resolve(transcriptPath);
    this.sink = sink;
    this.options = options;
  }

  async start(): Promise<PiPassiveScanResult> {
    if (this.timer) return this.scanOnce();
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.scanOnce().catch((cause: unknown) =>
        this.report({
          level: "error",
          code: "pi-passive-scan-failed",
          location: this.transcriptPath,
          message: String(cause),
        }),
      );
    }, this.options.pollMs ?? 500);
    this.timer.unref();
    return this.scanOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.scanTail.catch(() => undefined);
  }

  scanOnce(): Promise<PiPassiveScanResult> {
    const scan = this.scanTail.then(
      () => this.scan(),
      () => this.scan(),
    );
    this.scanTail = scan.catch(() => undefined);
    return scan;
  }

  private async scan(): Promise<PiPassiveScanResult> {
    if (this.stopped) throw new Error("Pi passive observer is stopped");
    if (this.pendingCommit) {
      await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);
      await saveState(this.options.statePath, this.pendingCommit.state);
      this.state = this.pendingCommit.state;
      const committed = this.pendingCommit;
      this.pendingCommit = undefined;
      return {
        changed: true,
        emittedEvents: 0,
        sessionId: committed.state.sessionId,
      };
    }

    const state = await this.ensureState();
    const metadata = await stat(this.transcriptPath);
    const snapshot = fileSnapshot(metadata);
    if (sameSnapshot(snapshot, state.file)) {
      return { changed: false, emittedEvents: 0, sessionId: state.sessionId };
    }

    const loaded = await loadPiSession(this.transcriptPath, {
      sourceId: state.sourceId,
      sessionId: state.sessionId,
    });
    for (const diagnostic of loaded.diagnostics) this.report(diagnostic);
    if (!this.options.allowPartial && loaded.diagnostics.some((item) => item.level === "error")) {
      throw new Error("Pi session contains errors; passive cursor was not advanced");
    }

    const eventIds = new Set(state.eventIds);
    const candidates = loaded.events.filter((event) => !eventIds.has(event.event_id));
    for (const event of candidates) {
      await this.sink.write(event);
      eventIds.add(event.event_id);
    }
    const next: PiPassiveState = {
      ...state,
      file: snapshot,
      eventIds: [...eventIds].sort(),
    };
    this.pendingCommit = { state: next, emittedEvents: candidates.length };
    if (candidates.length > 0) await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);
    await saveState(this.options.statePath, next);
    this.state = next;
    this.pendingCommit = undefined;
    return { changed: true, emittedEvents: candidates.length, sessionId: state.sessionId };
  }

  private async ensureState(): Promise<PiPassiveState> {
    if (this.state) return this.state;
    const identity = await parsePiSession(this.transcriptPath);
    const sourceId = this.options.sourceId ?? "pi-local";
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.statePath, "utf8"));
      if (
        isState(parsed) &&
        parsed.transcriptPath === this.transcriptPath &&
        parsed.sourceId === sourceId &&
        parsed.sessionId === identity.header.id
      ) {
        this.state = parsed;
        return parsed;
      }
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT" && !(cause instanceof SyntaxError)) {
        throw cause;
      }
    }
    this.state = {
      schemaVersion: 1,
      transcriptPath: this.transcriptPath,
      sourceId,
      sessionId: identity.header.id,
      eventIds: [],
    };
    return this.state;
  }

  private report(diagnostic: PiDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }
}

function fileSnapshot(metadata: Awaited<ReturnType<typeof stat>>): FileSnapshot {
  return {
    identity: `${metadata.dev}:${metadata.ino}`,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
  };
}

function sameSnapshot(left: FileSnapshot, right?: FileSnapshot): boolean {
  return Boolean(
    right &&
      left.identity === right.identity &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs,
  );
}

function isState(value: unknown): value is PiPassiveState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<PiPassiveState>;
  return (
    state.schemaVersion === 1 &&
    typeof state.transcriptPath === "string" &&
    typeof state.sourceId === "string" &&
    typeof state.sessionId === "string" &&
    Array.isArray(state.eventIds) &&
    state.eventIds.every((eventId) => typeof eventId === "string")
  );
}

async function saveState(path: string, state: PiPassiveState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
