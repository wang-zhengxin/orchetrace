import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { mapAntigravityRecords } from "./mapper.ts";
import type {
  AntigravityDiagnostic,
  AntigravityLoadResult,
  AntigravitySessionIdentity,
  AntigravityToolCall,
  AntigravityTranscriptRecord,
} from "./types.ts";

export async function loadAntigravitySession(
  path: string,
  sourceId = "antigravity-cli-local",
): Promise<AntigravityLoadResult> {
  const text = await readFile(path, "utf8");
  const diagnostics: AntigravityDiagnostic[] = [];
  const records = parseAntigravityRecords(text, path, 1, diagnostics);
  const identity = identityFromTranscriptPath(path);
  return {
    identity,
    diagnostics,
    ...mapAntigravityRecords(records, { sourceId, identity }),
  };
}

export function parseAntigravityRecords(
  text: string,
  path: string,
  firstLine: number,
  diagnostics: AntigravityDiagnostic[],
): AntigravityTranscriptRecord[] {
  const records: AntigravityTranscriptRecord[] = [];
  for (const [offset, raw] of text.split("\n").entries()) {
    const line = firstLine + offset;
    if (!raw.trim()) continue;
    try {
      const value: unknown = JSON.parse(raw);
      const object = objectValue(value);
      if (!object) throw new Error("record is not an object");
      const stepIndex = integerValue(object.step_index);
      const source = stringValue(object.source);
      const type = stringValue(object.type);
      const status = stringValue(object.status);
      const createdAt = stringValue(object.created_at);
      if (stepIndex === undefined || !source || !type || !status || !createdAt) {
        throw new Error("record is missing step_index, source, type, status, or created_at");
      }
      if (!Number.isFinite(Date.parse(createdAt))) throw new Error("record has invalid created_at");
      records.push({
        line,
        stepIndex,
        source,
        type,
        status,
        createdAt,
        ...(stringValue(object.content) ? { content: stringValue(object.content)! } : {}),
        ...(stringValue(object.thinking) ? { thinking: stringValue(object.thinking)! } : {}),
        toolCalls: toolCallsValue(object.tool_calls),
      });
    } catch (cause: unknown) {
      diagnostics.push({
        level: "warning",
        code: "antigravity-line-invalid",
        location: `${path}#${line}`,
        message: String(cause),
      });
    }
  }
  return records;
}

export function identityFromTranscriptPath(path: string): AntigravitySessionIdentity {
  const absolute = resolve(path);
  const logsDirectory = dirname(absolute);
  const systemDirectory = dirname(logsDirectory);
  const brainDirectory = dirname(systemDirectory);
  const sessionId = basename(brainDirectory);
  if (!/^[0-9A-Za-z][0-9A-Za-z-]{7,}$/.test(sessionId)) {
    throw new Error(`Antigravity transcript is not below a conversation directory: ${path}`);
  }
  return {
    sessionId,
    label: sessionId,
    role: "orchestrator",
    depth: 0,
  };
}

export function sourceIdForAntigravityRoot(root: string): string {
  const normalized = resolve(root);
  return `antigravity-${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function toolCallsValue(value: unknown): AntigravityToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectValue(item);
    const name = stringValue(record?.name);
    if (!record || !name) return [];
    return [{ name, args: objectValue(record.args) ?? {} }];
  });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}
