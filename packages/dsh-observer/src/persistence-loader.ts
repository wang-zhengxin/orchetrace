import { execFile } from "node:child_process";
import * as zlib from "node:zlib";

import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import type { HarnessSessionEvent, HarnessSessionHeader } from "./harness-types.ts";
import { mapDshRecord } from "./mapper.ts";

export interface DshPersistenceDiagnostic {
  level: "warning" | "error";
  code: string;
  location: string;
  message: string;
}

export interface DshPersistenceLoadResult {
  header: HarnessSessionHeader;
  events: CanonicalEvent[];
  sourceEvents: HarnessSessionEvent[];
  diagnostics: DshPersistenceDiagnostic[];
}

/** Reads the Harness Zstandard JSONL persistence format without loading Harness itself. */
export async function loadDshPersistence(
  path: string,
  sourceId = "dsh-local",
): Promise<DshPersistenceLoadResult> {
  const text = (await decompressZstdFile(path)).toString("utf8");
  const diagnostics: DshPersistenceDiagnostic[] = [];
  const records: Array<{ line: number; value: Record<string, unknown> }> = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value)) throw new Error("line is not a JSON object");
      records.push({ line: index + 1, value });
    } catch (cause: unknown) {
      diagnostics.push({
        level: "error",
        code: "dsh-line-json-invalid",
        location: `persistence#${index + 1}`,
        message: String(cause),
      });
    }
  }
  const header = parseHeader(records[0]?.value);
  const sourceEvents: HarnessSessionEvent[] = [];
  for (const record of records.slice(1)) {
    const event = parseEvent(record.value);
    // *-chunks records are storage compression frames. Direct seq records around
    // them retain the authoritative lifecycle/tool/message high-water.
    if (event) sourceEvents.push(event);
  }
  sourceEvents.sort((left, right) => left.seq - right.seq);
  const descriptor = sourceEvents.find((event) => event.type === "subagent/descriptor")?.data;
  const isChild = header.parentSession !== undefined;
  const events = mapDshRecord({
    kind: "session_announced",
    sourceId,
    header,
    descriptor: {
      mode: isChild ? (descriptor?.mode === "continuable" ? "continuable" : "one-shot") : "root",
      label:
        typeof descriptor?.label === "string"
          ? descriptor.label
          : isChild
            ? `agent ${header.id.slice(0, 8)}`
            : "root agent",
      provider: typeof descriptor?.agentProvider === "string" ? descriptor.agentProvider : undefined,
      model: typeof descriptor?.agentModel === "string" ? descriptor.agentModel : undefined,
      detailLevel: "full",
    },
  });
  for (const event of sourceEvents) {
    try {
      events.push(
        ...mapDshRecord({
          kind: "session_event",
          sourceId,
          sessionId: header.id,
          parentSessionId: header.parentSession,
          event,
        }),
      );
    } catch (cause: unknown) {
      diagnostics.push({
        level: "warning",
        code: "dsh-event-unsupported",
        location: `${header.id}#${event.seq}`,
        message: String(cause),
      });
    }
  }
  return { header, events, sourceEvents, diagnostics };
}

function parseHeader(value: Record<string, unknown> | undefined): HarnessSessionHeader {
  if (!value || value.type !== "session") throw new Error("Harness persistence has no session header");
  const id = stringField(value, "id");
  const createdAt = numberField(value, "createdAt");
  const version = numberField(value, "version");
  if (!id || createdAt === undefined || version === undefined) {
    throw new Error("Harness session header requires id, version, and createdAt");
  }
  return {
    version,
    id,
    createdAt,
    cwd: stringField(value, "cwd"),
    parentSession: stringField(value, "parentSession"),
    seedLength: numberField(value, "seedLength"),
    origin: value.origin === "subagent" ? "subagent" : undefined,
    delegationDepth: numberField(value, "delegationDepth"),
    agentPreset: stringField(value, "agentPreset"),
  };
}

function parseEvent(value: Record<string, unknown>): HarnessSessionEvent | undefined {
  const seq = numberField(value, "seq");
  const time = numberField(value, "time");
  const type = stringField(value, "type");
  if (!Number.isInteger(seq) || time === undefined || !type) return undefined;
  return {
    type,
    seq: seq as number,
    time,
    data: isRecord(value.data) ? value.data : {},
    ...(value.ignorable === true ? { ignorable: true as const } : {}),
  };
}

async function decompressZstdFile(path: string): Promise<Buffer> {
  // Harness persistence is a concatenation of hundreds of independent Zstd
  // frames. Node's one-shot decoder stops after frame one, while the reference
  // zstd CLI correctly walks the complete stream.
  const bundled = process.env.ORCHETRACE_ZSTD_PATH;
  if (bundled) {
    return execFileBuffer(bundled, ["decompress-zstd", path]);
  }
  for (const command of ["/opt/homebrew/bin/zstd", "/usr/local/bin/zstd", "zstd"]) {
    try {
      return await execZstd(command, path);
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  return decompressSingleFrame(await import("node:fs/promises").then(({ readFile }) => readFile(path)));
}

function execZstd(command: string, path: string): Promise<Buffer> {
  return execFileBuffer(command, ["-dc", path]);
}

function execFileBuffer(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout as Buffer);
    });
  });
}

function decompressSingleFrame(bytes: Buffer): Promise<Buffer> {
  const decoder = (zlib as unknown as {
    zstdDecompress?: (input: Buffer, callback: (error: Error | null, output: Buffer) => void) => void;
  }).zstdDecompress;
  if (!decoder) {
    throw new Error("Harness monitoring requires the zstd executable or Node.js Zstandard support");
  }
  return new Promise((resolve, reject) => {
    decoder(bytes, (error, output) => (error ? reject(error) : resolve(output)));
  });
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" && Number.isFinite(value[key])
    ? (value[key] as number)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
