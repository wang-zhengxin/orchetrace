import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import { CodexPassiveObserver } from "./passive-observer.ts";
import type { CodexDiagnostic } from "./types.ts";

export interface CodexTranscriptCandidate {
  transcriptPath: string;
  mtimeMs: number;
}

export interface CodexAutoDiscoveryOptions {
  sessionsDir?: string;
  stateDir: string;
  scanMs?: number;
  observerPollMs?: number;
  activeWithinMs?: number;
  includeExisting?: boolean;
  onDiagnostic?: (diagnostic: CodexDiagnostic) => void;
  onStatus?: (status: CodexAutoDiscoveryStatus) => void;
}

export interface CodexAutoDiscoveryStatus {
  sessionsDir: string;
  observedSessions: number;
  discoveredSessions: number;
  lastScanAt: string;
}

export class CodexAutoDiscovery {
  private readonly sink: AcknowledgedCanonicalEventSink;
  private readonly options: CodexAutoDiscoveryOptions;
  private readonly sessionsDir: string;
  private readonly observers = new Map<string, CodexPassiveObserver>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private scanTail: Promise<CodexAutoDiscoveryStatus> = Promise.resolve({
    sessionsDir: "", observedSessions: 0, discoveredSessions: 0, lastScanAt: new Date(0).toISOString(),
  });

  constructor(sink: AcknowledgedCanonicalEventSink, options: CodexAutoDiscoveryOptions) {
    this.sink = sink;
    this.options = options;
    this.sessionsDir = expandHome(options.sessionsDir ?? resolve(homedir(), ".codex/sessions"));
  }

  async start(): Promise<CodexAutoDiscoveryStatus> {
    if (this.timer) return this.scanOnce();
    this.stopped = false;
    const status = await this.scanOnce();
    this.timer = setInterval(() => void this.scanOnce().catch((cause: unknown) => this.report({
      level: "error", code: "codex-auto-scan-failed", location: this.sessionsDir, message: String(cause),
    })), this.options.scanMs ?? 1_000);
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

  scanOnce(): Promise<CodexAutoDiscoveryStatus> {
    const scan = this.scanTail.then(() => this.scan(), () => this.scan());
    this.scanTail = scan;
    return scan;
  }

  observedPaths(): string[] {
    return [...this.observers.keys()].sort();
  }

  private async scan(): Promise<CodexAutoDiscoveryStatus> {
    if (this.stopped) throw new Error("Codex auto discovery is stopped");
    const candidates = await discoverCodexTranscripts(this.sessionsDir);
    const cutoff = Date.now() - (this.options.activeWithinMs ?? 6 * 60 * 60 * 1_000);
    const eligible = candidates.filter((candidate) => this.options.includeExisting
      || candidate.mtimeMs >= cutoff
      || this.observers.has(candidate.transcriptPath));
    for (const candidate of eligible.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      await this.observe(candidate);
    }
    const status = {
      sessionsDir: this.sessionsDir,
      observedSessions: this.observers.size,
      discoveredSessions: candidates.length,
      lastScanAt: new Date().toISOString(),
    } satisfies CodexAutoDiscoveryStatus;
    this.options.onStatus?.(status);
    return status;
  }

  private async observe(candidate: CodexTranscriptCandidate): Promise<void> {
    const transcriptPath = resolve(candidate.transcriptPath);
    if (this.observers.has(transcriptPath)) return;
    const observer = new CodexPassiveObserver(transcriptPath, this.sink, {
      statePath: resolve(this.options.stateDir, `session-${shortHash(transcriptPath)}.cursor.json`),
      pollMs: this.options.observerPollMs ?? 400,
      ackTimeoutMs: 5 * 60 * 1_000,
      onDiagnostic: (diagnostic) => this.report(diagnostic),
    });
    this.observers.set(transcriptPath, observer);
    try {
      await observer.start();
      this.report({
        level: "warning",
        code: "codex-session-observed",
        location: transcriptPath,
        message: `observing Codex session ${basename(transcriptPath, ".jsonl")}`,
      });
    } catch (cause: unknown) {
      this.report({
        level: "warning",
        code: "codex-session-initializing",
        location: transcriptPath,
        message: `initial scan will retry in place: ${String(cause)}`,
      });
    }
  }

  private report(diagnostic: CodexDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }
}

export async function discoverCodexTranscripts(sessionsDir: string): Promise<CodexTranscriptCandidate[]> {
  const root = expandHome(sessionsDir);
  const candidates: CodexTranscriptCandidate[] = [];
  await visit(root, candidates);
  return candidates.sort((left, right) => left.transcriptPath.localeCompare(right.transcriptPath));
}

async function visit(path: string, candidates: CodexTranscriptCandidate[]): Promise<void> {
  for (const entry of await entries(path)) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await visit(child, candidates);
    else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      const metadata = await stat(child);
      candidates.push({ transcriptPath: child, mtimeMs: metadata.mtimeMs });
    }
  }
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
