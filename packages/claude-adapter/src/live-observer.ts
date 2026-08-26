import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

import type { AcknowledgedCanonicalEventSink } from "../../adapter-runtime/src/index.ts";
import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import { loadClaudeSources } from "./loader.ts";
import { mapClaudeSources } from "./mapper.ts";
import type { ClaudeAgentSource, ClaudeDiagnostic } from "./types.ts";

interface FileCheckpoint {
  identity: string;
  offset: number;
  mtimeMs: number;
}

interface CursorState {
  schemaVersion: 1;
  sourceId: string;
  transcriptPath: string;
  generation: number;
  files: Record<string, FileCheckpoint>;
  lines: Record<string, number>;
  structuralKeys: string[];
  identities: Record<string, string>;
}

interface PendingCommit {
  state: CursorState;
  diagnostics: ClaudeDiagnostic[];
}

export interface ClaudeLiveObserverOptions {
  sourceId?: string;
  sessionId?: string;
  statePath: string;
  pollMs?: number;
  ackTimeoutMs?: number;
  allowPartial?: boolean;
  onDiagnostic?: (diagnostic: ClaudeDiagnostic) => void;
}

export interface ClaudeScanResult {
  changed: boolean;
  emittedEvents: number;
  generation: number;
  diagnostics: ClaudeDiagnostic[];
}

/** Polling Claude file observer with ACK-gated, atomically persisted cursors. */
export class ClaudeLiveObserver {
  private readonly transcriptPath: string;
  private readonly sink: AcknowledgedCanonicalEventSink;
  private readonly options: ClaudeLiveObserverOptions;
  private state?: CursorState;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private scanTail: Promise<unknown> = Promise.resolve();
  private pendingCommit?: PendingCommit;

  constructor(
    transcriptPath: string,
    sink: AcknowledgedCanonicalEventSink,
    options: ClaudeLiveObserverOptions,
  ) {
    this.transcriptPath = resolve(transcriptPath);
    this.sink = sink;
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    await this.scanOnce();
    this.timer = setInterval(() => {
      void this.scanOnce().catch((cause: unknown) =>
        this.report({
          level: "error",
          code: "live-scan-failed",
          location: this.transcriptPath,
          message: String(cause),
        }),
      );
    }, this.options.pollMs ?? 500);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.scanTail;
  }

  scanOnce(): Promise<ClaudeScanResult> {
    const scan = this.scanTail.then(
      () => this.scan(),
      () => this.scan(),
    );
    this.scanTail = scan.catch(() => undefined);
    return scan;
  }

  private async scan(): Promise<ClaudeScanResult> {
    if (this.stopped) throw new Error("Claude live observer is stopped");
    if (this.pendingCommit) {
      await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);
      await saveState(this.options.statePath, this.pendingCommit.state);
      const committed = this.pendingCommit;
      this.pendingCommit = undefined;
      this.state = committed.state;
      return {
        changed: true,
        emittedEvents: 0,
        generation: committed.state.generation,
        diagnostics: committed.diagnostics,
      };
    }
    const state = await this.ensureState();
    const files = await snapshotInputFiles(this.transcriptPath);
    const changed = fileSetChanged(state.files, files);
    if (!changed) {
      return { changed: false, emittedEvents: 0, generation: state.generation, diagnostics: [] };
    }

    const replacedLocations = replacementLocations(this.transcriptPath, state.files, files);
    const generation = replacedLocations.size > 0 ? state.generation + 1 : state.generation;
    const loaded = await loadClaudeSources(this.transcriptPath, {
      sourceId: state.sourceId,
      sessionId: this.options.sessionId,
    });
    for (const diagnostic of loaded.diagnostics) this.report(diagnostic);
    if (!this.options.allowPartial && loaded.diagnostics.some((item) => item.level === "error")) {
      throw new Error("Claude source contains errors; cursor was not advanced");
    }

    const events = mapClaudeSources(loaded.sources, state.sourceId, loaded.diagnostics, {
      mode: "live",
      eventEpoch: generation,
    });
    const committedLines = { ...state.lines };
    for (const location of replacedLocations) committedLines[location] = 0;
    const structuralKeys = new Set(state.structuralKeys);
    const candidates = events.filter((event) => shouldEmit(event, committedLines, structuralKeys));
    const identityUpdates = metadataUpdates(loaded.sources, state, files, generation);
    candidates.push(...identityUpdates.filter((event) => !structuralKeys.has(structuralKey(event))));
    candidates.sort(compareEvents);

    const nextLines = { ...committedLines };
    for (const event of events) {
      const line = lineReference(event);
      if (line) nextLines[line.location] = Math.max(nextLines[line.location] ?? 0, line.line);
    }
    for (const event of candidates) {
      if (!lineReference(event)) structuralKeys.add(structuralKey(event));
    }
    const identities = {
      ...state.identities,
      ...Object.fromEntries(loaded.sources.map((source) => [source.id, identityFingerprint(source)])),
    };
    const next: CursorState = {
      ...state,
      generation,
      files,
      lines: nextLines,
      structuralKeys: [...structuralKeys].sort(),
      identities,
    };
    for (const event of candidates) await this.sink.write(event);
    this.pendingCommit = { state: next, diagnostics: loaded.diagnostics };
    await this.sink.whenIdle(this.options.ackTimeoutMs ?? 30_000);
    await saveState(this.options.statePath, next);
    this.pendingCommit = undefined;
    this.state = next;
    return {
      changed: true,
      emittedEvents: candidates.length,
      generation,
      diagnostics: loaded.diagnostics,
    };
  }

  private async ensureState(): Promise<CursorState> {
    if (this.state) return this.state;
    const sourceId = this.options.sourceId ?? `claude-${shortHash(this.transcriptPath)}`;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.statePath, "utf8"));
      if (!isCursorState(parsed)) throw new Error("unsupported or malformed cursor state");
      if (parsed.transcriptPath !== this.transcriptPath || parsed.sourceId !== sourceId) {
        throw new Error("cursor belongs to a different transcript or source-id");
      }
      this.state = parsed;
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      this.state = {
        schemaVersion: 1,
        sourceId,
        transcriptPath: this.transcriptPath,
        generation: 0,
        files: {},
        lines: {},
        structuralKeys: [],
        identities: {},
      };
    }
    return this.state;
  }

  private report(diagnostic: ClaudeDiagnostic): void {
    this.options.onDiagnostic?.(diagnostic);
  }
}

async function snapshotInputFiles(transcriptPath: string): Promise<Record<string, FileCheckpoint>> {
  const paths = [transcriptPath];
  const stem = basename(transcriptPath, ".jsonl");
  await collectFiles(resolve(dirname(transcriptPath), stem, "subagents"), paths);
  const result: Record<string, FileCheckpoint> = {};
  for (const path of paths.sort()) {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) continue;
      result[resolve(path)] = {
        identity: `${metadata.dev}:${metadata.ino}`,
        offset: metadata.size,
        mtimeMs: metadata.mtimeMs,
      };
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  return result;
}

async function collectFiles(directory: string, result: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(path, result);
    else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".meta.json"))) {
      result.push(path);
    }
  }
}

function fileSetChanged(
  previous: Record<string, FileCheckpoint>,
  current: Record<string, FileCheckpoint>,
): boolean {
  const paths = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...paths].some((path) => {
    const left = previous[path];
    const right = current[path];
    return !left || !right || left.identity !== right.identity || left.offset !== right.offset || left.mtimeMs !== right.mtimeMs;
  });
}

function replacementLocations(
  transcriptPath: string,
  previous: Record<string, FileCheckpoint>,
  current: Record<string, FileCheckpoint>,
): Set<string> {
  const locations = new Set<string>();
  for (const [path, before] of Object.entries(previous)) {
    const after = current[path];
    if (!after || !path.endsWith(".jsonl")) continue;
    const replaced =
      before.identity !== after.identity ||
      after.offset < before.offset ||
      (after.offset === before.offset && after.mtimeMs !== before.mtimeMs);
    if (replaced) locations.add(logicalLocation(transcriptPath, path));
  }
  return locations;
}

function logicalLocation(transcriptPath: string, path: string): string {
  if (resolve(path) === resolve(transcriptPath)) return "main";
  const stem = basename(transcriptPath, ".jsonl");
  const nested = relative(resolve(dirname(transcriptPath), stem, "subagents"), path).split(/[/\\]/);
  if (nested[0] === "workflows" && nested.length >= 3) {
    const workflow = nested[1];
    if (nested[2] === "journal.jsonl") return `workflow:${workflow}:journal`;
    const agent = /^agent-(.+)\.jsonl$/.exec(nested[2])?.[1];
    if (agent) return `workflow:${workflow}:${agent}`;
  }
  const agent = /^agent-(.+)\.jsonl$/.exec(nested[0])?.[1];
  return agent ? `direct:${agent}` : relative(dirname(transcriptPath), path);
}

function lineReference(event: CanonicalEvent): { location: string; line: number } | undefined {
  const match = /^(.*)#(\d+)$/.exec(event.source_ref?.location ?? "");
  if (!match) return undefined;
  return { location: match[1], line: Number(match[2]) };
}

function shouldEmit(
  event: CanonicalEvent,
  committedLines: Record<string, number>,
  structuralKeys: Set<string>,
): boolean {
  const line = lineReference(event);
  if (line) return line.line > (committedLines[line.location] ?? 0);
  return !structuralKeys.has(structuralKey(event));
}

function metadataUpdates(
  sources: ClaudeAgentSource[],
  state: CursorState,
  files: Record<string, FileCheckpoint>,
  generation: number,
): CanonicalEvent[] {
  const latestMtime = Math.max(0, ...Object.values(files).map((file) => file.mtimeMs));
  return sources.flatMap((source) => {
    const fingerprint = identityFingerprint(source);
    if (!state.identities[source.id] || state.identities[source.id] === fingerprint) return [];
    const at = new Date(latestMtime).toISOString();
    const data = identityData(source);
    const revision = shortHash(JSON.stringify({ data, at }));
    return [
      {
        schema_version: 1,
        event_id: `claude:${encodeURIComponent(state.sourceId)}:${encodeURIComponent(source.id)}:metadata-${revision}:epoch-${generation}`,
        runtime: "claude-code",
        source_id: state.sourceId,
        session_id: source.id,
        ...(source.parentId ? { parent_session_id: source.parentId } : {}),
        source_seq: 970_000_000 + generation,
        observed_at: at,
        occurred_at: at,
        type: "session.metadata_changed",
        data,
        source_ref: { kind: "subagent-meta", location: `${source.id}#metadata-${revision}` },
      } satisfies CanonicalEvent,
    ];
  });
}

function identityData(source: ClaudeAgentSource): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      label: source.label,
      role: source.role,
      origin: source.kind,
      workflow_id: source.workflowId,
      spawned_by_tool_use: source.toolUseId,
    }).filter(([, value]) => value !== undefined),
  );
}

function identityFingerprint(source: ClaudeAgentSource): string {
  return shortHash(JSON.stringify(identityData(source)));
}

function structuralKey(event: CanonicalEvent): string {
  return event.event_id.replace(/:epoch-\d+$/, "");
}

function compareEvents(left: CanonicalEvent, right: CanonicalEvent): number {
  return [left.occurred_at ?? left.observed_at, left.session_id, left.source_seq, left.event_id]
    .join("\0")
    .localeCompare([right.occurred_at ?? right.observed_at, right.session_id, right.source_seq, right.event_id].join("\0"));
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function saveState(path: string, state: CursorState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function isCursorState(value: unknown): value is CursorState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<CursorState>;
  return (
    state.schemaVersion === 1 &&
    typeof state.sourceId === "string" &&
    typeof state.transcriptPath === "string" &&
    typeof state.generation === "number" &&
    Boolean(state.files && state.lines && state.structuralKeys && state.identities) &&
    Array.isArray(state.structuralKeys)
  );
}
