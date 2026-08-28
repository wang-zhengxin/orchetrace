import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import { loadDshPersistence, type DshPersistenceDiagnostic } from "./persistence-loader.ts";

interface FileSnapshot {
  identity: string;
  size: number;
  mtimeMs: number;
}

interface DshPersistenceState {
  schemaVersion: 1;
  persistencePath: string;
  sourceId: string;
  sessionId: string;
  file?: FileSnapshot;
  eventIds: string[];
}

interface PendingCommit {
  state: DshPersistenceState;
}

export interface DshPersistenceObserverOptions {
  statePath: string;
  sourceId?: string;
  pollMs?: number;
  ackTimeoutMs?: number;
  onDiagnostic?: (diagnostic: DshPersistenceDiagnostic) => void;
}

export interface DshPersistenceScanResult {
  changed: boolean;
  emittedEvents: number;
  sessionId: string;
}

/** Polls one persisted Harness session with ACK-gated cursor commits. */
export class DshPersistenceObserver {
  private readonly persistencePath: string;
  private readonly sink: AcknowledgedCanonicalEventSink;
  private readonly options: DshPersistenceObserverOptions;
  private state?: DshPersistenceState;
  private pendingCommit?: PendingCommit;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private scanTail: Promise<unknown> = Promise.resolve();

  constructor(
    persistencePath: string,
    sink: AcknowledgedCanonicalEventSink,
    options: DshPersistenceObserverOptions,
  ) {
    this.persistencePath = resolve(persistencePath);
    this.sink = sink;
    this.options = options;
  }

  async start(): Promise<DshPersistenceScanResult> {
    if (this.timer) return this.scanOnce();
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.scanOnce().catch((cause: unknown) =>
        this.report({
          level: "error",
          code: "dsh-persistence-scan-failed",
          location: this.persistencePath,
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

  scanOnce(): Promise<DshPersistenceScanResult> {
    const scan = this.scanTail.then(
      () => this.scan(),
      () => this.scan(),
    );
    this.scanTail = scan.catch(() => undefined);
    return scan;
  }

  private async scan(): Promise<DshPersistenceScanResult> {
    if (this.stopped) throw new Error("Harness persistence observer is stopped");
    if (this.pendingCommit) {
      await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);
      await saveState(this.options.statePath, this.pendingCommit.state);
      this.state = this.pendingCommit.state;
      this.pendingCommit = undefined;
      return { changed: true, emittedEvents: 0, sessionId: this.state.sessionId };
    }
    const metadata = await stat(this.persistencePath);
    const snapshot = fileSnapshot(metadata);
    const state = await this.ensureState();
    if (sameSnapshot(snapshot, state.file)) {
      return { changed: false, emittedEvents: 0, sessionId: state.sessionId };
    }
    const loaded = await loadDshPersistence(this.persistencePath, state.sourceId);
    for (const diagnostic of loaded.diagnostics) this.report(diagnostic);
    if (loaded.header.id !== state.sessionId) {
      throw new Error(`Harness persistence identity changed from ${state.sessionId} to ${loaded.header.id}`);
    }
    const eventIds = new Set(state.eventIds);
    const candidates = loaded.events.filter((event) => !eventIds.has(event.event_id));
    for (const event of candidates) {
      await this.sink.write(event);
      eventIds.add(event.event_id);
    }
    const next: DshPersistenceState = {
      ...state,
      file: snapshot,
      eventIds: [...eventIds].sort(),
    };
    this.pendingCommit = { state: next };
    if (candidates.length > 0) await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);
    await saveState(this.options.statePath, next);
    this.state = next;
    this.pendingCommit = undefined;
    return { changed: true, emittedEvents: candidates.length, sessionId: state.sessionId };
  }

  private async ensureState(): Promise<DshPersistenceState> {
    if (this.state) return this.state;
    const sourceId = this.options.sourceId ?? "dsh-local";
    const loaded = await loadDshPersistence(this.persistencePath, sourceId);
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.statePath, "utf8"));
      if (
        isState(parsed) &&
        parsed.persistencePath === this.persistencePath &&
        parsed.sourceId === sourceId &&
        parsed.sessionId === loaded.header.id
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
      persistencePath: this.persistencePath,
      sourceId,
      sessionId: loaded.header.id,
      eventIds: [],
    };
    return this.state;
  }

  private report(diagnostic: DshPersistenceDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }
}

function fileSnapshot(metadata: Awaited<ReturnType<typeof stat>>): FileSnapshot {
  return { identity: `${metadata.dev}:${metadata.ino}`, size: metadata.size, mtimeMs: metadata.mtimeMs };
}

function sameSnapshot(left: FileSnapshot, right?: FileSnapshot): boolean {
  return Boolean(
    right &&
      left.identity === right.identity &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs,
  );
}

function isState(value: unknown): value is DshPersistenceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<DshPersistenceState>;
  return (
    state.schemaVersion === 1 &&
    typeof state.persistencePath === "string" &&
    typeof state.sourceId === "string" &&
    typeof state.sessionId === "string" &&
    Array.isArray(state.eventIds) &&
    state.eventIds.every((eventId) => typeof eventId === "string")
  );
}

async function saveState(path: string, state: DshPersistenceState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
