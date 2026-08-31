import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  readCompleteFileTail,
  type FileTailCursor,
} from "../../adapter-runtime/src/index.ts";

import { mapPiSession } from "./mapper.ts";
import type {
  PiDiagnostic,
  PiEntry,
  PiHeader,
  PiLoadResult,
  PiParsedSession,
  PiSessionOptions,
} from "./types.ts";

const CURRENT_VERSION = 3;

export async function loadPiSession(
  path: string,
  options: PiSessionOptions = {},
): Promise<PiLoadResult> {
  const parsed = await parsePiSession(path, options.sessionId);
  const events = mapPiSession(parsed, options.sourceId ?? "pi-local", {
    rootLifecycle: options.rootLifecycle ?? true,
  });
  return {
    events,
    diagnostics: parsed.diagnostics,
    activeLeafId: parsed.activePath.at(-1)?.id,
    activeEntryCount: parsed.activePath.length,
    abandonedEntryCount: parsed.entries.length - parsed.activePath.length,
  };
}

export async function parsePiSession(path: string, sessionId?: string): Promise<PiParsedSession> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read Pi session ${path}: ${String(error)}`);
  }
  return parsePiSessionText(text, sessionId);
}

interface PiSourceRecord {
  line: number;
  value: Record<string, unknown>;
}

export function parsePiSessionText(text: string, sessionId?: string): PiParsedSession {
  const diagnostics: PiDiagnostic[] = [];
  const records = parsePiRecords(text, 1, diagnostics);
  return buildPiSession(records, diagnostics, sessionId);
}

export interface PiIncrementalSessionCacheOptions {
  maxCachedBytes?: number;
  maxReadBytes?: number;
}

export interface PiIncrementalSessionLoadResult {
  parsed: PiParsedSession;
  bytesRead: number;
  cachedBytes: number;
}

/** Caches parsed Pi JSON records and reads only complete appended byte ranges. */
export class PiIncrementalSessionCache {
  private readonly path: string;
  private readonly maxCachedBytes: number;
  private readonly maxReadBytes: number;
  private cursor?: FileTailCursor;
  private records: PiSourceRecord[] = [];
  private syntaxDiagnostics: PiDiagnostic[] = [];
  private parsed?: PiParsedSession;
  private parsedSessionId?: string;

  constructor(path: string, options: PiIncrementalSessionCacheOptions = {}) {
    this.path = resolve(path);
    this.maxCachedBytes = options.maxCachedBytes ?? 128 * 1024 * 1024;
    this.maxReadBytes = options.maxReadBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxCachedBytes) || this.maxCachedBytes <= 0) {
      throw new Error("Pi maxCachedBytes must be a positive safe integer");
    }
  }

  async load(sessionId?: string): Promise<PiIncrementalSessionLoadResult> {
    let bytesRead = 0;
    let semanticInputChanged = false;
    while (true) {
      const tail = await readCompleteFileTail(this.path, this.cursor, {
        maxBytes: this.maxReadBytes,
      });
      bytesRead += tail.bytesRead;
      if (tail.reset) {
        this.records = [];
        this.syntaxDiagnostics = [];
        this.parsed = undefined;
        semanticInputChanged = true;
      }
      if (tail.text) {
        semanticInputChanged = true;
        this.records.push(
          ...parsePiRecords(tail.text, tail.startLine, this.syntaxDiagnostics),
        );
      }
      this.cursor = tail.cursor;
      if (!tail.text || tail.cursor.offset >= tail.fileSize) break;
    }
    const cachedBytes = this.cursor?.offset ?? 0;
    if (cachedBytes > this.maxCachedBytes) {
      throw new Error(`Pi parsed session cache reached ${cachedBytes} bytes; limit is ${this.maxCachedBytes}`);
    }
    if (!semanticInputChanged && this.parsed && this.parsedSessionId === sessionId) {
      return { parsed: this.parsed, bytesRead, cachedBytes };
    }
    const diagnostics = this.syntaxDiagnostics.map((diagnostic) => ({ ...diagnostic }));
    this.parsed = buildPiSession(this.records, diagnostics, sessionId);
    this.parsedSessionId = sessionId;
    return {
      parsed: this.parsed,
      bytesRead,
      cachedBytes,
    };
  }
}

function parsePiRecords(
  text: string,
  startLine: number,
  diagnostics: PiDiagnostic[],
): PiSourceRecord[] {
  const records: PiSourceRecord[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const line = startLine + index;
    const location = `session#${line}`;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value)) throw new Error("line is not a JSON object");
      records.push({ line, value });
    } catch (error) {
      diagnostics.push({
        level: "error",
        code: "line-json-invalid",
        location,
        message: `cannot parse Pi JSONL line: ${String(error)}`,
      });
    }
  }
  return records;
}

function buildPiSession(
  records: PiSourceRecord[],
  diagnostics: PiDiagnostic[],
  sessionId?: string,
): PiParsedSession {
  const rawHeader = records[0]?.value;
  if (!rawHeader || rawHeader.type !== "session") throw new Error("Pi session has no leading session header");
  const headerId = sessionId ?? stringField(rawHeader, "id");
  const timestamp = timestampField(rawHeader, "timestamp");
  if (!headerId || !timestamp) throw new Error("Pi session header requires string id and valid timestamp");
  const versionValue = rawHeader.version ?? 1;
  if (!Number.isInteger(versionValue) || Number(versionValue) < 1) throw new Error("Pi session version is invalid");
  const version = Number(versionValue);
  if (version > CURRENT_VERSION) {
    diagnostics.push({
      level: "error",
      code: "session-version-unsupported",
      location: `session#${records[0].line}`,
      message: `Pi session version ${version} is newer than supported version ${CURRENT_VERSION}`,
    });
  }
  const header: PiHeader = {
    type: "session",
    version,
    id: headerId,
    timestamp,
    cwd: stringField(rawHeader, "cwd"),
    parentSession: stringField(rawHeader, "parentSession"),
  };
  const entries = normalizeEntries(records.slice(1), version, diagnostics);
  const activePath = buildActivePath(entries, diagnostics);
  return {
    header,
    entries,
    activePath,
    contextEntryIds: buildContextEntryIds(activePath, diagnostics),
    diagnostics,
  };
}

function normalizeEntries(
  records: Array<{ line: number; value: Record<string, unknown> }>,
  version: number,
  diagnostics: PiDiagnostic[],
): PiEntry[] {
  const entries: PiEntry[] = [];
  const ids = new Set<string>();
  let previousId: string | null = null;
  for (const record of records) {
    const location = `session#${record.line}`;
    const type = stringField(record.value, "type");
    const timestamp = timestampField(record.value, "timestamp");
    const id = stringField(record.value, "id") ?? (version === 1 ? `legacy-${record.line}` : undefined);
    const rawParent = record.value.parentId;
    const parentId =
      typeof rawParent === "string" || rawParent === null
        ? rawParent
        : version === 1
          ? previousId
          : undefined;
    if (!type || !timestamp || !id || parentId === undefined) {
      diagnostics.push({
        level: "error",
        code: "entry-invalid",
        location,
        message: "Pi entry requires type, id, parentId, and valid timestamp",
      });
      continue;
    }
    if (ids.has(id)) {
      diagnostics.push({
        level: "error",
        code: "entry-id-duplicate",
        location,
        message: `duplicate Pi entry id ${id}`,
      });
      continue;
    }
    ids.add(id);
    entries.push({ type, id, parentId, timestamp, line: record.line, value: record.value });
    previousId = id;
  }
  if (version === 1) {
    for (const entry of entries) {
      if (entry.type !== "compaction" || typeof entry.value.firstKeptEntryId === "string") continue;
      const legacyIndex = entry.value.firstKeptEntryIndex;
      if (!Number.isInteger(legacyIndex) || Number(legacyIndex) < 1) continue;
      const targetRecord = records[Number(legacyIndex) - 1];
      const target = targetRecord
        ? entries.find((candidate) => candidate.line === targetRecord.line)
        : undefined;
      if (target) entry.value = { ...entry.value, firstKeptEntryId: target.id };
    }
  }
  return entries;
}

function buildActivePath(entries: PiEntry[], diagnostics: PiDiagnostic[]): PiEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: PiEntry[] = [];
  const seen = new Set<string>();
  let current = entries.at(-1);
  while (current) {
    if (seen.has(current.id)) {
      diagnostics.push({
        level: "error",
        code: "entry-cycle",
        location: `session#${current.line}`,
        message: `Pi entry tree contains a cycle at ${current.id}`,
      });
      break;
    }
    seen.add(current.id);
    path.push(current);
    if (current.parentId === null) break;
    const parent = byId.get(current.parentId);
    if (!parent) {
      diagnostics.push({
        level: "error",
        code: "entry-parent-missing",
        location: `session#${current.line}`,
        message: `active Pi entry ${current.id} references missing parent ${current.parentId}`,
      });
      break;
    }
    current = parent;
  }
  return path.reverse();
}

function buildContextEntryIds(activePath: PiEntry[], diagnostics: PiDiagnostic[]): Set<string> {
  const latestCompaction = [...activePath].reverse().find((entry) => entry.type === "compaction");
  if (!latestCompaction) return new Set(activePath.map((entry) => entry.id));
  const compactionIndex = activePath.indexOf(latestCompaction);
  const firstKeptId = stringField(latestCompaction.value, "firstKeptEntryId");
  const firstKeptIndex = firstKeptId
    ? activePath.findIndex((entry) => entry.id === firstKeptId)
    : -1;
  if (firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) {
    diagnostics.push({
      level: "warning",
      code: "compaction-first-kept-missing",
      location: `session#${latestCompaction.line}`,
      message: "latest Pi compaction references no earlier active entry",
    });
  }
  const ids = new Set<string>([latestCompaction.id]);
  if (firstKeptIndex >= 0) {
    for (const entry of activePath.slice(firstKeptIndex, compactionIndex)) ids.add(entry.id);
  }
  for (const entry of activePath.slice(compactionIndex + 1)) ids.add(entry.id);
  return ids;
}

function timestampField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = stringField(value, key);
  if (!raw || !Number.isFinite(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString();
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
