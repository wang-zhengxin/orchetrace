import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  readCompleteFileTail,
  type FileTailCursor,
} from "../../adapter-runtime/src/index.ts";

import { mapClaudeSources } from "./mapper.ts";
import type {
  ClaudeAgentSource,
  ClaudeDiagnostic,
  ClaudeLoadResult,
  ClaudeSessionOptions,
  ClaudeSourceLoadResult,
  ParsedLine,
} from "./types.ts";

export async function loadClaudeSession(
  transcriptPath: string,
  options: ClaudeSessionOptions = {},
): Promise<ClaudeLoadResult> {
  const result = await loadClaudeSources(transcriptPath, options);
  return {
    events: mapClaudeSources(result.sources, options.sourceId ?? "claude-local", result.diagnostics, {
      mode: options.mode,
      eventEpoch: options.eventEpoch,
    }),
    diagnostics: result.diagnostics,
  };
}

export async function loadClaudeSources(
  transcriptPath: string,
  options: ClaudeSessionOptions = {},
): Promise<ClaudeSourceLoadResult> {
  const diagnostics: ClaudeDiagnostic[] = [];
  const stem = basename(transcriptPath, ".jsonl");
  const sessionId = options.sessionId ?? stem;
  const mainLines = await readJsonl(transcriptPath, "main", diagnostics);
  const sources: ClaudeAgentSource[] = [
    {
      id: sessionId,
      kind: "root",
      label: mainTitle(mainLines) ?? sessionId,
      role: "orchestrator",
      lines: mainLines,
    },
  ];
  const subagentsDirectory = join(dirname(transcriptPath), stem, "subagents");

  for (const fileName of await directoryFiles(subagentsDirectory)) {
    const match = /^agent-(.+)\.jsonl$/.exec(fileName);
    if (!match) continue;
    const agentId = match[1];
    const meta = await readMeta(join(subagentsDirectory, `agent-${agentId}.meta.json`), diagnostics);
    sources.push({
      id: agentId,
      parentId: sessionId,
      kind: "direct",
      label: stringField(meta, "description") ?? stringField(meta, "agentType") ?? agentId,
      role: stringField(meta, "agentType"),
      toolUseId: stringField(meta, "toolUseId"),
      lines: await readJsonl(join(subagentsDirectory, fileName), `direct:${agentId}`, diagnostics),
    });
  }

  const workflowsDirectory = join(subagentsDirectory, "workflows");
  for (const workflowId of await directoryDirectories(workflowsDirectory)) {
    const workflowPath = join(workflowsDirectory, workflowId);
    const groupId = `workflow:${workflowId}`;
    const launch = workflowLaunch(mainLines, workflowId);
    const journal = await readJsonl(join(workflowPath, "journal.jsonl"), `workflow:${workflowId}:journal`, diagnostics, true);
    sources.push({
      id: groupId,
      parentId: sessionId,
      kind: "workflow-group",
      label: launch.name ?? workflowId,
      role: "workflow",
      toolUseId: launch.toolUseId,
      workflowId,
      lines: journal,
    });
    for (const fileName of await directoryFiles(workflowPath)) {
      const match = /^agent-(.+)\.jsonl$/.exec(fileName);
      if (!match) continue;
      const agentId = match[1];
      const meta = await readMeta(join(workflowPath, `agent-${agentId}.meta.json`), diagnostics);
      sources.push({
        id: agentId,
        parentId: groupId,
        kind: "workflow-subagent",
        label: stringField(meta, "description") ?? stringField(meta, "agentType") ?? agentId,
        role: stringField(meta, "agentType") ?? "workflow-subagent",
        workflowId,
        lines: await readJsonl(join(workflowPath, fileName), `workflow:${workflowId}:${agentId}`, diagnostics),
      });
    }
  }

  return { sources, diagnostics };
}

export interface ClaudeIncrementalSourceCacheOptions {
  maxCachedBytes?: number;
  maxReadBytes?: number;
}

export interface ClaudeIncrementalSourceLoadResult extends ClaudeSourceLoadResult {
  bytesRead: number;
  cachedBytes: number;
}

interface CachedJsonl {
  cursor: FileTailCursor;
  lines: ParsedLine[];
}

interface CachedMeta {
  signature: string;
  value: Record<string, unknown>;
}

/** Keeps parsed Claude source lines in memory and reads only appended byte ranges. */
export class ClaudeIncrementalSourceCache {
  private readonly transcriptPath: string;
  private readonly maxCachedBytes: number;
  private readonly maxReadBytes: number;
  private readonly documents = new Map<string, CachedJsonl>();
  private readonly metas = new Map<string, CachedMeta>();
  private bytesRead = 0;
  private readonly touchedDocuments = new Set<string>();
  private readonly touchedMetas = new Set<string>();

  constructor(transcriptPath: string, options: ClaudeIncrementalSourceCacheOptions = {}) {
    this.transcriptPath = resolve(transcriptPath);
    this.maxCachedBytes = options.maxCachedBytes ?? 128 * 1024 * 1024;
    this.maxReadBytes = options.maxReadBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxCachedBytes) || this.maxCachedBytes <= 0) {
      throw new Error("Claude maxCachedBytes must be a positive safe integer");
    }
  }

  async load(options: ClaudeSessionOptions = {}): Promise<ClaudeIncrementalSourceLoadResult> {
    this.bytesRead = 0;
    this.touchedDocuments.clear();
    this.touchedMetas.clear();
    const diagnostics: ClaudeDiagnostic[] = [];
    const stem = basename(this.transcriptPath, ".jsonl");
    const sessionId = options.sessionId ?? stem;
    const mainLines = await this.readJsonl(this.transcriptPath, "main", diagnostics);
    const sources: ClaudeAgentSource[] = [
      {
        id: sessionId,
        kind: "root",
        label: mainTitle(mainLines) ?? sessionId,
        role: "orchestrator",
        lines: mainLines,
      },
    ];
    const subagentsDirectory = join(dirname(this.transcriptPath), stem, "subagents");

    for (const fileName of await directoryFiles(subagentsDirectory)) {
      const match = /^agent-(.+)\.jsonl$/.exec(fileName);
      if (!match) continue;
      const agentId = match[1];
      const meta = await this.readMeta(
        join(subagentsDirectory, `agent-${agentId}.meta.json`),
        diagnostics,
      );
      sources.push({
        id: agentId,
        parentId: sessionId,
        kind: "direct",
        label: stringField(meta, "description") ?? stringField(meta, "agentType") ?? agentId,
        role: stringField(meta, "agentType"),
        toolUseId: stringField(meta, "toolUseId"),
        lines: await this.readJsonl(
          join(subagentsDirectory, fileName),
          `direct:${agentId}`,
          diagnostics,
        ),
      });
    }

    const workflowsDirectory = join(subagentsDirectory, "workflows");
    for (const workflowId of await directoryDirectories(workflowsDirectory)) {
      const workflowPath = join(workflowsDirectory, workflowId);
      const groupId = `workflow:${workflowId}`;
      const launch = workflowLaunch(mainLines, workflowId);
      const journal = await this.readJsonl(
        join(workflowPath, "journal.jsonl"),
        `workflow:${workflowId}:journal`,
        diagnostics,
        true,
      );
      sources.push({
        id: groupId,
        parentId: sessionId,
        kind: "workflow-group",
        label: launch.name ?? workflowId,
        role: "workflow",
        toolUseId: launch.toolUseId,
        workflowId,
        lines: journal,
      });
      for (const fileName of await directoryFiles(workflowPath)) {
        const match = /^agent-(.+)\.jsonl$/.exec(fileName);
        if (!match) continue;
        const agentId = match[1];
        const meta = await this.readMeta(
          join(workflowPath, `agent-${agentId}.meta.json`),
          diagnostics,
        );
        sources.push({
          id: agentId,
          parentId: groupId,
          kind: "workflow-subagent",
          label: stringField(meta, "description") ?? stringField(meta, "agentType") ?? agentId,
          role: stringField(meta, "agentType") ?? "workflow-subagent",
          workflowId,
          lines: await this.readJsonl(
            join(workflowPath, fileName),
            `workflow:${workflowId}:${agentId}`,
            diagnostics,
          ),
        });
      }
    }

    this.pruneUntouched();
    const cachedBytes = [...this.documents.values()]
      .reduce((total, document) => total + document.cursor.offset, 0);
    if (cachedBytes > this.maxCachedBytes) {
      throw new Error(
        `Claude parsed source cache reached ${cachedBytes} bytes; limit is ${this.maxCachedBytes}`,
      );
    }
    return { sources, diagnostics, bytesRead: this.bytesRead, cachedBytes };
  }

  private async readJsonl(
    inputPath: string,
    locationPrefix: string,
    diagnostics: ClaudeDiagnostic[],
    optional = false,
  ): Promise<ParsedLine[]> {
    const path = resolve(inputPath);
    this.touchedDocuments.add(path);
    let document = this.documents.get(path);
    try {
      while (true) {
        const tail = await readCompleteFileTail(path, document?.cursor, {
          maxBytes: this.maxReadBytes,
        });
        this.bytesRead += tail.bytesRead;
        const lines = tail.reset ? [] : [...(document?.lines ?? [])];
        if (tail.text) {
          lines.push(...parseJsonlText(tail.text, locationPrefix, tail.startLine, diagnostics));
        }
        document = { cursor: tail.cursor, lines };
        this.documents.set(path, document);
        if (!tail.text || tail.cursor.offset >= tail.fileSize) break;
      }
      return document?.lines ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.documents.delete(path);
        if (optional) return [];
      }
      diagnostics.push({
        level: "error",
        code: "source-read-failed",
        location: locationPrefix,
        message: `cannot read Claude source: ${String(error)}`,
      });
      return document?.lines ?? [];
    }
  }

  private async readMeta(
    inputPath: string,
    diagnostics: ClaudeDiagnostic[],
  ): Promise<Record<string, unknown>> {
    const path = resolve(inputPath);
    this.touchedMetas.add(path);
    try {
      const metadata = await stat(path);
      const signature = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
      const cached = this.metas.get(path);
      if (cached?.signature === signature) return cached.value;
      const text = await readFile(path, "utf8");
      this.bytesRead += Buffer.byteLength(text);
      const value: unknown = JSON.parse(text);
      if (!isRecord(value)) throw new Error("meta is not a JSON object");
      this.metas.set(path, { signature, value });
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.metas.delete(path);
        return {};
      }
      diagnostics.push({
        level: "warning",
        code: "meta-read-failed",
        location: basename(path),
        message: `cannot read subagent meta: ${String(error)}`,
      });
      return {};
    }
  }

  private pruneUntouched(): void {
    for (const path of this.documents.keys()) {
      if (!this.touchedDocuments.has(path)) this.documents.delete(path);
    }
    for (const path of this.metas.keys()) {
      if (!this.touchedMetas.has(path)) this.metas.delete(path);
    }
  }
}

async function readJsonl(
  path: string,
  locationPrefix: string,
  diagnostics: ClaudeDiagnostic[],
  optional = false,
): Promise<ParsedLine[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!optional) {
      diagnostics.push({
        level: "error",
        code: "source-read-failed",
        location: locationPrefix,
        message: `cannot read Claude source: ${String(error)}`,
      });
    }
    return [];
  }
  return parseJsonlText(text, locationPrefix, 1, diagnostics);
}

function parseJsonlText(
  text: string,
  locationPrefix: string,
  startLine: number,
  diagnostics: ClaudeDiagnostic[],
): ParsedLine[] {
  const lines: ParsedLine[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const line = startLine + index;
    const location = `${locationPrefix}#${line}`;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value)) throw new Error("line is not a JSON object");
      lines.push({ line, location, value });
    } catch (error) {
      diagnostics.push({
        level: "error",
        code: "line-json-invalid",
        location,
        message: `cannot parse Claude JSONL line: ${String(error)}`,
      });
    }
  }
  return lines;
}

async function readMeta(
  path: string,
  diagnostics: ClaudeDiagnostic[],
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) throw new Error("meta is not a JSON object");
    return value;
  } catch (error) {
    diagnostics.push({
      level: "warning",
      code: "meta-read-failed",
      location: basename(path),
      message: `cannot read subagent meta: ${String(error)}`,
    });
    return {};
  }
}

async function directoryFiles(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function directoryDirectories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function mainTitle(lines: ParsedLine[]): string | undefined {
  for (const line of lines) {
    if (line.value.type === "ai-title") return stringField(line.value, "aiTitle");
  }
  return undefined;
}

function workflowLaunch(
  lines: ParsedLine[],
  workflowId: string,
): { name?: string; toolUseId?: string } {
  for (const line of lines) {
    const result = isRecord(line.value.toolUseResult) ? line.value.toolUseResult : undefined;
    if (result?.taskType !== "local_workflow" || result.runId !== workflowId) continue;
    const content = isRecord(line.value.message) ? line.value.message.content : undefined;
    const block = Array.isArray(content)
      ? content.map((item) => (isRecord(item) ? item : undefined)).find((item) => item?.type === "tool_result")
      : undefined;
    return {
      name: stringField(result, "workflowName"),
      toolUseId: stringField(block, "tool_use_id"),
    };
  }
  return {};
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const item = value?.[key];
  return typeof item === "string" ? item : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
