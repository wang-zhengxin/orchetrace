import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import {
  DshPersistenceObserver,
  type DshPersistenceObserverOptions,
} from "./persistence-observer.ts";

export interface DshPersistenceCandidate {
  persistencePath: string;
  projectDirectory: string;
  mtimeMs: number;
}

export interface DshAutoDiscoveryOptions {
  sessionsDir?: string;
  stateDir: string;
  scanMs?: number;
  observerPollMs?: number;
  activeWithinMs?: number;
  includeExisting?: boolean;
  onDiagnostic?: DshPersistenceObserverOptions["onDiagnostic"];
  onStatus?: (status: DshAutoDiscoveryStatus) => void;
}

export interface DshAutoDiscoveryStatus {
  sessionsDir: string;
  observedSessions: number;
  discoveredSessions: number;
  lastScanAt: string;
}

/** Discovers persisted DeepSeek Harness sessions and attaches passive observers. */
export class DshAutoDiscovery {
  private readonly sink: AcknowledgedCanonicalEventSink;
  private readonly options: DshAutoDiscoveryOptions;
  private readonly sessionsDir: string;
  private readonly observers = new Map<string, DshPersistenceObserver>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private scanTail: Promise<DshAutoDiscoveryStatus> = Promise.resolve({
    sessionsDir: "",
    observedSessions: 0,
    discoveredSessions: 0,
    lastScanAt: new Date(0).toISOString(),
  });

  constructor(sink: AcknowledgedCanonicalEventSink, options: DshAutoDiscoveryOptions) {
    this.sink = sink;
    this.options = options;
    this.sessionsDir = expandHome(options.sessionsDir ?? resolve(homedir(), ".dsh/sessions"));
  }

  async start(): Promise<DshAutoDiscoveryStatus> {
    if (this.timer) return this.scanOnce();
    this.stopped = false;
    const status = await this.scanOnce();
    this.timer = setInterval(() => {
      void this.scanOnce().catch((cause: unknown) =>
        this.report({
          level: "error",
          code: "dsh-auto-scan-failed",
          location: this.sessionsDir,
          message: String(cause),
        }),
      );
    }, this.options.scanMs ?? 1_000);
    this.timer.unref();
    return status;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.scanTail.catch(() => undefined);
    await Promise.all([...this.observers.values()].map((observer) => observer.stop()));
    this.observers.clear();
  }

  scanOnce(): Promise<DshAutoDiscoveryStatus> {
    const scan = this.scanTail.then(
      () => this.scan(),
      () => this.scan(),
    );
    this.scanTail = scan;
    return scan;
  }

  observedPaths(): string[] {
    return [...this.observers.keys()].sort();
  }

  private async scan(): Promise<DshAutoDiscoveryStatus> {
    if (this.stopped) throw new Error("Harness auto discovery is stopped");
    const candidates = await discoverDshPersistence(this.sessionsDir);
    const cutoff = Date.now() - (this.options.activeWithinMs ?? 6 * 60 * 60 * 1_000);
    const eligible = candidates.filter(
      (candidate) =>
        this.options.includeExisting ||
        candidate.mtimeMs >= cutoff ||
        this.observers.has(resolve(candidate.persistencePath)),
    );
    for (const candidate of eligible.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      await this.observe(candidate);
    }
    const status = {
      sessionsDir: this.sessionsDir,
      observedSessions: this.observers.size,
      discoveredSessions: candidates.length,
      lastScanAt: new Date().toISOString(),
    } satisfies DshAutoDiscoveryStatus;
    this.options.onStatus?.(status);
    return status;
  }

  private async observe(candidate: DshPersistenceCandidate): Promise<void> {
    const persistencePath = resolve(candidate.persistencePath);
    if (this.observers.has(persistencePath)) return;
    const observer = new DshPersistenceObserver(persistencePath, this.sink, {
      sourceId: "dsh-local",
      statePath: resolve(this.options.stateDir, `session-${shortHash(persistencePath)}.cursor.json`),
      pollMs: this.options.observerPollMs ?? 500,
      ackTimeoutMs: 5 * 60 * 1_000,
      onDiagnostic: (diagnostic) => this.report(diagnostic),
    });
    this.observers.set(persistencePath, observer);
    try {
      await observer.start();
      this.report({
        level: "warning",
        code: "dsh-session-observed",
        location: persistencePath,
        message: `observing Harness session ${resolve(persistencePath, "..").split("/").at(-1)}`,
      });
    } catch (cause: unknown) {
      this.report({
        level: "warning",
        code: "dsh-session-initializing",
        location: persistencePath,
        message: `initial scan will retry in place: ${String(cause)}`,
      });
    }
  }

  private report(diagnostic: Parameters<NonNullable<DshAutoDiscoveryOptions["onDiagnostic"]>>[0]): void {
    this.options.onDiagnostic?.(diagnostic);
  }
}

export async function discoverDshPersistence(sessionsDir: string): Promise<DshPersistenceCandidate[]> {
  const root = expandHome(sessionsDir);
  const candidates: DshPersistenceCandidate[] = [];
  for (const project of await directories(root)) {
    const projectDirectory = resolve(root, project.name);
    for (const session of await directories(projectDirectory)) {
      const persistencePath = resolve(projectDirectory, session.name, "session.jsonl.zstd");
      try {
        const metadata = await stat(persistencePath);
        if (metadata.isFile()) candidates.push({ persistencePath, projectDirectory, mtimeMs: metadata.mtimeMs });
      } catch (cause: unknown) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
  }
  return candidates.sort((left, right) => left.persistencePath.localeCompare(right.persistencePath));
}

async function directories(path: string): Promise<Awaited<ReturnType<typeof readdir>>> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
