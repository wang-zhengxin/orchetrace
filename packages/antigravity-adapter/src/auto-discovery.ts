import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import { sourceIdForAntigravityRoot } from "./loader.ts";
import { AntigravityPassiveObserver } from "./passive-observer.ts";
import type { AntigravityDiagnostic } from "./types.ts";

export interface AntigravityTranscriptCandidate {
  transcriptPath: string;
  mtimeMs: number;
}

export interface AntigravityAutoDiscoveryOptions {
  sessionsDir?: string;
  stateDir: string;
  hookEventsPath?: string;
  scanMs?: number;
  observerPollMs?: number;
  activeWithinMs?: number;
  includeExisting?: boolean;
  onDiagnostic?: (diagnostic: AntigravityDiagnostic) => void;
  onStatus?: (status: AntigravityAutoDiscoveryStatus) => void;
}

export interface AntigravityAutoDiscoveryStatus {
  sessionsDir: string;
  observedSessions: number;
  discoveredSessions: number;
  hookEvents: number;
  lastScanAt: string;
}

export class AntigravityAutoDiscovery {
  private readonly sink: AcknowledgedCanonicalEventSink;
  private readonly options: AntigravityAutoDiscoveryOptions;
  private readonly sessionsDir: string;
  private readonly sourceId: string;
  private readonly hookEventsPath: string;
  private readonly observers = new Map<string, AntigravityPassiveObserver>();
  private readonly hookPaths = new Set<string>();
  private hookOffset = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private scanTail: Promise<AntigravityAutoDiscoveryStatus> = Promise.resolve({
    sessionsDir: "",
    observedSessions: 0,
    discoveredSessions: 0,
    hookEvents: 0,
    lastScanAt: new Date(0).toISOString(),
  });

  constructor(sink: AcknowledgedCanonicalEventSink, options: AntigravityAutoDiscoveryOptions) {
    this.sink = sink;
    this.options = options;
    this.sessionsDir = expandHome(
      options.sessionsDir ?? resolve(homedir(), ".gemini/antigravity-cli/brain"),
    );
    this.sourceId = sourceIdForAntigravityRoot(this.sessionsDir);
    this.hookEventsPath = expandHome(
      options.hookEventsPath ?? resolve(homedir(), ".orchetrace/antigravity-hooks.jsonl"),
    );
  }

  async start(): Promise<AntigravityAutoDiscoveryStatus> {
    if (this.timer) return this.scanOnce();
    this.stopped = false;
    const status = await this.scanOnce();
    this.timer = setInterval(() => {
      void this.scanOnce().catch((cause: unknown) => this.report({
        level: "error",
        code: "antigravity-auto-scan-failed",
        location: this.sessionsDir,
        message: String(cause),
      }));
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

  scanOnce(): Promise<AntigravityAutoDiscoveryStatus> {
    const scan = this.scanTail.then(() => this.scan(), () => this.scan());
    this.scanTail = scan;
    return scan;
  }

  observedPaths(): string[] {
    return [...this.observers.keys()].sort();
  }

  private async scan(): Promise<AntigravityAutoDiscoveryStatus> {
    if (this.stopped) throw new Error("Antigravity auto discovery is stopped");
    const hookEvents = await this.readHookEvents();
    const candidates = await discoverAntigravityTranscripts(this.sessionsDir);
    const cutoff = Date.now() - (this.options.activeWithinMs ?? 6 * 60 * 60 * 1_000);
    const eligible = candidates.filter((candidate) => this.options.includeExisting
      || candidate.mtimeMs >= cutoff
      || this.hookPaths.has(resolve(candidate.transcriptPath))
      || this.observers.has(candidate.transcriptPath));
    for (const hookPath of this.hookPaths) {
      if (eligible.some((candidate) => resolve(candidate.transcriptPath) === hookPath)) continue;
      try {
        const metadata = await stat(hookPath);
        if (metadata.isFile()) eligible.push({ transcriptPath: hookPath, mtimeMs: metadata.mtimeMs });
      } catch (cause: unknown) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
    for (const candidate of eligible.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      await this.observe(candidate);
    }
    const status = {
      sessionsDir: this.sessionsDir,
      observedSessions: this.observers.size,
      discoveredSessions: candidates.length,
      hookEvents,
      lastScanAt: new Date().toISOString(),
    } satisfies AntigravityAutoDiscoveryStatus;
    this.options.onStatus?.(status);
    return status;
  }

  private async observe(candidate: AntigravityTranscriptCandidate): Promise<void> {
    const transcriptPath = resolve(candidate.transcriptPath);
    if (this.observers.has(transcriptPath)) return;
    const observer = new AntigravityPassiveObserver(transcriptPath, this.sink, {
      statePath: resolve(this.options.stateDir, `session-${shortHash(transcriptPath)}.cursor.json`),
      sourceId: this.sourceId,
      pollMs: this.options.observerPollMs ?? 350,
      ackTimeoutMs: 5 * 60 * 1_000,
      onDiagnostic: (diagnostic) => this.report(diagnostic),
    });
    this.observers.set(transcriptPath, observer);
    try {
      await observer.start();
    } catch (cause: unknown) {
      this.report({
        level: "warning",
        code: "antigravity-session-initializing",
        location: transcriptPath,
        message: `initial scan will retry in place: ${String(cause)}`,
      });
    }
  }

  private report(diagnostic: AntigravityDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }

  private async readHookEvents(): Promise<number> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.hookEventsPath);
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw cause;
    }
    if (bytes.length < this.hookOffset) this.hookOffset = 0;
    const remaining = bytes.subarray(this.hookOffset);
    const lastNewline = remaining.lastIndexOf(0x0a);
    if (lastNewline < 0) return 0;
    const complete = remaining.subarray(0, lastNewline + 1).toString("utf8");
    this.hookOffset += lastNewline + 1;
    let accepted = 0;
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (!isHookRecord(record)) continue;
        this.hookPaths.add(resolve(expandHome(record.transcript_path)));
        accepted += 1;
      } catch (cause: unknown) {
        this.report({
          level: "warning",
          code: "antigravity-hook-record-invalid",
          location: this.hookEventsPath,
          message: String(cause),
        });
      }
    }
    return accepted;
  }
}

export async function discoverAntigravityTranscripts(
  sessionsDir: string,
): Promise<AntigravityTranscriptCandidate[]> {
  const root = expandHome(sessionsDir);
  const candidates: AntigravityTranscriptCandidate[] = [];
  for (const conversation of await entries(root)) {
    if (!conversation.isDirectory()) continue;
    const transcriptPath = resolve(
      root,
      conversation.name,
      ".system_generated/logs/transcript.jsonl",
    );
    try {
      const metadata = await stat(transcriptPath);
      if (metadata.isFile()) candidates.push({ transcriptPath, mtimeMs: metadata.mtimeMs });
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  return candidates.sort((left, right) => left.transcriptPath.localeCompare(right.transcriptPath));
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

function isHookRecord(value: unknown): value is { hook_event_name: string; transcript_path: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.hook_event_name === "string" && typeof record.transcript_path === "string";
}
