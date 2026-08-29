import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { identityFromSessionMeta, mapCodexRecord } from "./mapper.ts";
import type { CodexDiagnostic, CodexLoadResult, CodexRolloutRecord, CodexSessionIdentity } from "./types.ts";

export async function loadCodexSession(path: string, sourceId?: string): Promise<CodexLoadResult> {
  const text = await readFile(path, "utf8");
  const diagnostics: CodexDiagnostic[] = [];
  const records = parseCodexRecords(text, path, 1, diagnostics);
  const header = records
    .filter((record) => record.type === "session_meta")
    .map((record) => ({ record, identity: identityFromSessionMeta(record.payload) }))
    .find((value): value is { record: CodexRolloutRecord; identity: CodexSessionIdentity } => Boolean(value.identity));
  if (!header) throw new Error(`Codex rollout has no valid session_meta: ${path}`);
  const { identity } = header;
  const resolvedSourceId = sourceId ?? sourceIdFor(identity.cwd ?? identity.sessionId);
  return {
    identity,
    diagnostics,
    events: records.flatMap((record) => mapCodexRecord(record, {
      sourceId: resolvedSourceId,
      identity,
      headerLine: header.record.line,
    })),
  };
}

export function parseCodexRecords(
  text: string,
  path: string,
  firstLine: number,
  diagnostics: CodexDiagnostic[],
): CodexRolloutRecord[] {
  const records: CodexRolloutRecord[] = [];
  for (const [offset, raw] of text.split("\n").entries()) {
    const line = firstLine + offset;
    if (!raw.trim()) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record is not an object");
      const object = value as Record<string, unknown>;
      const type = typeof object.type === "string" ? object.type : undefined;
      const timestamp = typeof object.timestamp === "string" ? object.timestamp : undefined;
      const payload = object.payload;
      if (!type || !timestamp || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("record is missing timestamp, type, or payload");
      }
      records.push({ line, timestamp, type, payload: payload as Record<string, unknown> });
    } catch (cause: unknown) {
      diagnostics.push({
        level: "warning",
        code: "codex-line-invalid",
        location: `${path}#${line}`,
        message: String(cause),
      });
    }
  }
  return records;
}

export function sourceIdFor(identity: string): string {
  return `codex-project-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}
