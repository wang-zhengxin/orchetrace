import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
  const lines: ParsedLine[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const location = `${locationPrefix}#${index + 1}`;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value)) throw new Error("line is not a JSON object");
      lines.push({ line: index + 1, location, value });
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
