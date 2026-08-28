import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import { ClaudeLiveObserver } from "./live-observer.ts";
import type { ClaudeDiagnostic } from "./types.ts";

export interface ClaudeAutoDiscoveryOptions {
  projectsDir?: string;
  stateDir: string;
  hookEventsPath?: string;
  scanMs?: number;
  observerPollMs?: number;
  activeWithinMs?: number;
  includeExisting?: boolean;
  onDiagnostic?: (diagnostic: ClaudeDiagnostic) => void;
  onStatus?: (status: ClaudeAutoDiscoveryStatus) => void;
}

export interface ClaudeAutoDiscoveryStatus {
  projectsDir: string;
  observedSessions: number;
  discoveredSessions: number;
  hookEvents: number;
  lastScanAt: string;
}

export interface ClaudeTranscriptCandidate {
  transcriptPath: string;
  projectDirectory: string;
  mtimeMs: number;
}

interface ObserverEntry {
  observer: ClaudeLiveObserver;
  sourceId: string;
}

interface HookRecord {
  hook_event_name: string;
  transcript_path: string;
  session_id?: string;
  cwd?: string;
  at?: string;
}

/** Discovers Claude root transcripts and maintains one ACK-gated observer per session. */
export class ClaudeAutoDiscovery {
  private readonly sink: AcknowledgedCanonicalEventSink;
  private readonly options: ClaudeAutoDiscoveryOptions;
  private readonly projectsDir: string;
  private readonly hookEventsPath: string;
  private readonly observers = new Map<string, ObserverEntry>();
  private readonly hookPaths = new Set<string>();
  private hookOffset = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private scanTail: Promise<ClaudeAutoDiscoveryStatus> = Promise.resolve({
    projectsDir: "",
    observedSessions: 0,
    discoveredSessions: 0,
    hookEvents: 0,
    lastScanAt: new Date(0).toISOString(),
  });

  constructor(sink: AcknowledgedCanonicalEventSink, options: ClaudeAutoDiscoveryOptions) {
    this.sink = sink;
    this.options = options;
    this.projectsDir = expandHome(options.projectsDir ?? resolve(homedir(), ".claude/projects"));
    this.hookEventsPath = expandHome(
      options.hookEventsPath ?? resolve(homedir(), ".orchetrace/claude-hooks.jsonl"),
    );
  }

  async start(): Promise<ClaudeAutoDiscoveryStatus> {
    if (this.timer) return this.scanOnce();
    this.stopped = false;
    const status = await this.scanOnce();
    this.timer = setInterval(() => {
      void this.scanOnce().catch((cause: unknown) =>
        this.report({
          level: "error",
          code: "claude-auto-scan-failed",
          location: this.projectsDir,
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
    await Promise.all([...this.observers.values()].map(({ observer }) => observer.stop()));
    this.observers.clear();
  }

  scanOnce(): Promise<ClaudeAutoDiscoveryStatus> {
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

  private async scan(): Promise<ClaudeAutoDiscoveryStatus> {
    if (this.stopped) throw new Error("Claude auto discovery is stopped");
    const hookEvents = await this.readHookEvents();
    const candidates = await discoverClaudeTranscripts(this.projectsDir);
    const activeCutoff = Date.now() - (this.options.activeWithinMs ?? 6 * 60 * 60 * 1_000);
    const eligible = candidates.filter(
      (candidate) =>
        this.options.includeExisting ||
        candidate.mtimeMs >= activeCutoff ||
        this.hookPaths.has(resolve(candidate.transcriptPath)) ||
        this.observers.has(resolve(candidate.transcriptPath)),
    );

    for (const hookPath of this.hookPaths) {
      if (!eligible.some((candidate) => resolve(candidate.transcriptPath) === hookPath)) {
        try {
          const metadata = await stat(hookPath);
          if (metadata.isFile()) {
            eligible.push({
              transcriptPath: hookPath,
              projectDirectory: dirname(hookPath),
              mtimeMs: metadata.mtimeMs,
            });
          }
        } catch (cause: unknown) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      }
    }

    for (const candidate of eligible.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      await this.observe(candidate);
    }
    const status = {
      projectsDir: this.projectsDir,
      observedSessions: this.observers.size,
      discoveredSessions: candidates.length,
      hookEvents,
      lastScanAt: new Date().toISOString(),
    } satisfies ClaudeAutoDiscoveryStatus;
    this.options.onStatus?.(status);
    return status;
  }

  private async observe(candidate: ClaudeTranscriptCandidate): Promise<void> {
    const transcriptPath = resolve(candidate.transcriptPath);
    if (this.observers.has(transcriptPath)) return;
    const identity = shortHash(candidate.projectDirectory);
    const sourceId = `claude-project-${identity}`;
    const statePath = resolve(this.options.stateDir, `session-${shortHash(transcriptPath)}.cursor.json`);
    const observer = new ClaudeLiveObserver(transcriptPath, this.sink, {
      sourceId,
      statePath,
      pollMs: this.options.observerPollMs ?? 500,
      onDiagnostic: (diagnostic) => this.report(diagnostic),
    });
    await observer.start();
    this.observers.set(transcriptPath, { observer, sourceId });
    this.report({
      level: "warning",
      code: "claude-session-observed",
      location: transcriptPath,
      message: `observing Claude session ${basename(transcriptPath, ".jsonl")}`,
    });
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
          code: "claude-hook-record-invalid",
          location: this.hookEventsPath,
          message: String(cause),
        });
      }
    }
    return accepted;
  }

  private report(diagnostic: ClaudeDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }
}

export async function discoverClaudeTranscripts(projectsDir: string): Promise<ClaudeTranscriptCandidate[]> {
  const root = expandHome(projectsDir);
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  const candidates: ClaudeTranscriptCandidate[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDirectory = resolve(root, project.name);
    let entries;
    try {
      entries = await readdir(projectDirectory, { withFileTypes: true });
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const transcriptPath = resolve(projectDirectory, entry.name);
      const metadata = await stat(transcriptPath);
      candidates.push({ transcriptPath, projectDirectory, mtimeMs: metadata.mtimeMs });
    }
  }
  return candidates.sort((left, right) => left.transcriptPath.localeCompare(right.transcriptPath));
}

function isHookRecord(value: unknown): value is HookRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<HookRecord>;
  return typeof record.hook_event_name === "string" && typeof record.transcript_path === "string";
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
