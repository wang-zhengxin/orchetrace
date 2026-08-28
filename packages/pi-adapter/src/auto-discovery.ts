import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import { PiPassiveObserver } from "./passive-observer.ts";
import type { PiDiagnostic } from "./types.ts";

export interface PiTranscriptCandidate {
  transcriptPath: string;
  projectDirectory: string;
  mtimeMs: number;
}

export interface PiAutoDiscoveryOptions {
  sessionsDir?: string;
  stateDir: string;
  scanMs?: number;
  observerPollMs?: number;
  activeWithinMs?: number;
  includeExisting?: boolean;
  onDiagnostic?: (diagnostic: PiDiagnostic) => void;
  onStatus?: (status: PiAutoDiscoveryStatus) => void;
}

export interface PiAutoDiscoveryStatus {
  sessionsDir: string;
  observedSessions: number;
  discoveredSessions: number;
  lastScanAt: string;
}

/** Recursively discovers Pi project sessions and attaches passive file observers. */
export class PiAutoDiscovery {
  private readonly sink: AcknowledgedCanonicalEventSink;
  private readonly options: PiAutoDiscoveryOptions;
  private readonly sessionsDir: string;
  private readonly observers = new Map<string, PiPassiveObserver>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private scanTail: Promise<PiAutoDiscoveryStatus> = Promise.resolve({
    sessionsDir: "",
    observedSessions: 0,
    discoveredSessions: 0,
    lastScanAt: new Date(0).toISOString(),
  });

  constructor(sink: AcknowledgedCanonicalEventSink, options: PiAutoDiscoveryOptions) {
    this.sink = sink;
    this.options = options;
    this.sessionsDir = expandHome(options.sessionsDir ?? resolve(homedir(), ".pi/agent/sessions"));
  }

  async start(): Promise<PiAutoDiscoveryStatus> {
    if (this.timer) return this.scanOnce();
    this.stopped = false;
    const status = await this.scanOnce();
    this.timer = setInterval(() => {
      void this.scanOnce().catch((cause: unknown) =>
        this.report({
          level: "error",
          code: "pi-auto-scan-failed",
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

  scanOnce(): Promise<PiAutoDiscoveryStatus> {
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

  private async scan(): Promise<PiAutoDiscoveryStatus> {
    if (this.stopped) throw new Error("Pi auto discovery is stopped");
    const candidates = await discoverPiTranscripts(this.sessionsDir);
    const cutoff = Date.now() - (this.options.activeWithinMs ?? 6 * 60 * 60 * 1_000);
    const eligible = candidates.filter(
      (candidate) =>
        this.options.includeExisting ||
        candidate.mtimeMs >= cutoff ||
        this.observers.has(resolve(candidate.transcriptPath)),
    );
    for (const candidate of eligible.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      await this.observe(candidate);
    }
    const status = {
      sessionsDir: this.sessionsDir,
      observedSessions: this.observers.size,
      discoveredSessions: candidates.length,
      lastScanAt: new Date().toISOString(),
    } satisfies PiAutoDiscoveryStatus;
    this.options.onStatus?.(status);
    return status;
  }

  private async observe(candidate: PiTranscriptCandidate): Promise<void> {
    const transcriptPath = resolve(candidate.transcriptPath);
    if (this.observers.has(transcriptPath)) return;
    const observer = new PiPassiveObserver(transcriptPath, this.sink, {
      sourceId: `pi-project-${shortHash(candidate.projectDirectory)}`,
      statePath: resolve(this.options.stateDir, `session-${shortHash(transcriptPath)}.cursor.json`),
      pollMs: this.options.observerPollMs ?? 500,
      ackTimeoutMs: 5 * 60 * 1_000,
      onDiagnostic: (diagnostic) => this.report(diagnostic),
    });
    this.observers.set(transcriptPath, observer);
    try {
      await observer.start();
      this.report({
        level: "warning",
        code: "pi-session-observed",
        location: transcriptPath,
        message: `observing Pi session ${basename(transcriptPath, ".jsonl")}`,
      });
    } catch (cause: unknown) {
      this.report({
        level: "warning",
        code: "pi-session-initializing",
        location: transcriptPath,
        message: `initial scan will retry in place: ${String(cause)}`,
      });
    }
  }

  private report(diagnostic: PiDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }
}

export async function discoverPiTranscripts(sessionsDir: string): Promise<PiTranscriptCandidate[]> {
  const root = expandHome(sessionsDir);
  const candidates: PiTranscriptCandidate[] = [];
  for (const project of await directories(root)) {
    const projectDirectory = resolve(root, project.name);
    for (const entry of await entries(projectDirectory)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const transcriptPath = resolve(projectDirectory, entry.name);
      const metadata = await stat(transcriptPath);
      candidates.push({ transcriptPath, projectDirectory, mtimeMs: metadata.mtimeMs });
    }
  }
  return candidates.sort((left, right) => left.transcriptPath.localeCompare(right.transcriptPath));
}

async function directories(path: string): Promise<Awaited<ReturnType<typeof readdir>>> {
  return (await entries(path)).filter((entry) => entry.isDirectory());
}

async function entries(path: string): Promise<Awaited<ReturnType<typeof readdir>>> {
  try {
    return await readdir(path, { withFileTypes: true });
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
