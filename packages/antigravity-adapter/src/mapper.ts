import type { CanonicalEvent, CanonicalEventType, TerminalOutcome } from "../../protocol-ts/src/index.ts";
import type {
  AntigravityMapContext,
  AntigravityMapResult,
  AntigravityTranscriptRecord,
  PendingAntigravityTool,
} from "./types.ts";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function mapAntigravityRecords(
  records: readonly AntigravityTranscriptRecord[],
  context: AntigravityMapContext,
): AntigravityMapResult {
  const events: CanonicalEvent[] = [];
  const pendingTools = [...(context.pendingTools ?? [])];
  let activeActivationId = context.activeActivationId;
  for (const record of records) {
    if (record.line === 1) events.push(sessionDiscovered(record, context));
    if (record.type === "USER_INPUT") {
      const activationId = `turn-${record.stepIndex}`;
      if (activeActivationId) {
        events.push(
          event(record, context, `turn-end-${activeActivationId}`, "turn.ended", {
            turn_id: activeActivationId,
          }),
          event(record, context, `activation-end-${activeActivationId}`, "agent.activation_ended", {
            activation_id: activeActivationId,
            status: "ready",
          }),
        );
      }
      activeActivationId = activationId;
      events.push(
        event(record, context, "prompt", "prompt.accepted", {
          excerpt: summarize(record.content),
          source: "user",
        }),
        event(record, context, "activation-start", "agent.activation_started", {
          activation_id: activationId,
        }),
        event(record, context, "turn-start", "turn.started", { turn_id: activationId }),
        event(record, context, "status-running", "agent.status_changed", { status: "running" }),
      );
    }

    if (record.type === "PLANNER_RESPONSE") {
      if (record.thinking) {
        events.push(event(record, context, "reasoning", "assistant.reasoning_summary", {
          summary: summarize(record.thinking),
        }));
      }
      if (record.content) {
        events.push(event(record, context, "message", "assistant.message", {
          summary: summarize(record.content),
        }));
      }
      for (const [index, tool] of record.toolCalls.entries()) {
        const callId = `agy-tool-${record.stepIndex}-${index}`;
        pendingTools.push({ callId, name: tool.name, startedAt: record.createdAt });
        events.push(event(record, context, `tool-start-${index}`, "tool.started", {
          call_id: callId,
          name: tool.name,
          input_summary: summarizeToolArgs(tool.args),
        }));
      }
      if (record.status === "RUNNING") {
        events.push(event(record, context, "planner-running", "agent.status_changed", {
          status: "running",
        }));
      } else if (
        record.status === "DONE" &&
        record.toolCalls.length === 0 &&
        record.content &&
        activeActivationId
      ) {
        const activationId = activeActivationId;
        events.push(
          event(record, context, "turn-end", "turn.ended", { turn_id: activationId }),
          event(record, context, "activation-end", "agent.activation_ended", {
            activation_id: activationId,
            status: "ready",
          }),
        );
        activeActivationId = undefined;
      }
    }

    if (record.type === "GENERIC" && record.source === "MODEL" && record.content) {
      events.push(event(record, context, `generic-${record.status.toLowerCase()}`, "assistant.message", {
        summary: summarize(record.content),
      }));
    }

    const resultTool = toolNameForResult(record.type, pendingTools);
    if (resultTool) {
      const pendingIndex = pendingTools.findIndex((tool) => tool.name === resultTool);
      const pending = pendingIndex >= 0 ? pendingTools.splice(pendingIndex, 1)[0] : undefined;
      const callId = pending?.callId ?? `agy-result-${record.stepIndex}`;
      const outcome: TerminalOutcome = record.status === "DONE" ? "succeeded" : "failed";
      events.push(event(record, context, `tool-finish-${callId}`, "tool.finished", {
        call_id: callId,
        name: resultTool,
        outcome,
        ...(pending ? { duration_ms: durationMs(pending.startedAt, record.createdAt) } : {}),
        output_summary: summarize(record.content),
      }));
      if (resultTool === "invoke_subagent") {
        for (const [index, childId] of childConversationIds(record.content).entries()) {
          events.push(...childSpawnEvents(record, context, childId, index));
        }
      }
    }

    if (record.type === "CHECKPOINT") {
      events.push(event(record, context, "checkpoint", "step.ended", {
        step_id: `step-${record.stepIndex}`,
      }));
    }
    if (record.type === "ERROR_MESSAGE") {
      events.push(
        event(record, context, "error", "error.recorded", {
          category: "runtime",
          message: summarize(record.content) || "Antigravity reported an error",
        }),
        event(record, context, "status-waiting", "agent.status_changed", { status: "waiting" }),
      );
    }
  }
  return { events, pendingTools, ...(activeActivationId ? { activeActivationId } : {}) };
}

function sessionDiscovered(
  record: AntigravityTranscriptRecord,
  context: AntigravityMapContext,
): CanonicalEvent {
  return event(record, context, "session", "session.discovered", {
    label: context.identity.label,
    role: context.identity.role,
    mode: context.identity.parentSessionId ? "continuable" : "root",
    provider: "google",
    model: context.identity.model ?? "antigravity",
    workspace: context.identity.workspace,
    delegation_depth: context.identity.depth,
    origin: context.identity.parentSessionId ? "subagent" : "root",
  });
}

function childSpawnEvents(
  record: AntigravityTranscriptRecord,
  context: AntigravityMapContext,
  childId: string,
  index: number,
): CanonicalEvent[] {
  const data = {
    label: `subagent ${index + 1}`,
    role: "subagent",
    mode: "continuable",
    provider: "google",
    model: context.identity.model ?? "antigravity",
    delegation_depth: context.identity.depth + 1,
    origin: "subagent",
  };
  return [
    childEvent(record, context, childId, `child-session-${index}`, "session.discovered", data),
    childEvent(record, context, childId, `child-spawn-${index}`, "agent.spawned", data),
    childEvent(record, context, childId, `child-running-${index}`, "agent.status_changed", {
      status: "running",
    }),
  ];
}

function childEvent(
  record: AntigravityTranscriptRecord,
  context: AntigravityMapContext,
  childId: string,
  suffix: string,
  type: CanonicalEventType,
  data: Record<string, unknown>,
): CanonicalEvent {
  const base = event(record, context, suffix, type, data);
  return {
    ...base,
    event_id: `antigravity:${encodeURIComponent(context.sourceId)}:${encodeURIComponent(childId)}:${record.line}:${suffix}`,
    session_id: childId,
    parent_session_id: context.identity.sessionId,
  };
}

function event(
  record: AntigravityTranscriptRecord,
  context: AntigravityMapContext,
  suffix: string,
  type: CanonicalEventType,
  data: Record<string, unknown>,
): CanonicalEvent {
  return {
    schema_version: 1,
    event_id: `antigravity:${encodeURIComponent(context.sourceId)}:${encodeURIComponent(context.identity.sessionId)}:${record.line}:${suffix}`,
    runtime: "antigravity",
    source_id: context.sourceId,
    session_id: context.identity.sessionId,
    ...(context.identity.parentSessionId ? { parent_session_id: context.identity.parentSessionId } : {}),
    source_seq: record.line,
    observed_at: record.createdAt,
    occurred_at: record.createdAt,
    type,
    data: compact(data),
    attributes: {
      "antigravity.step_index": record.stepIndex,
      "antigravity.step_type": record.type,
      "antigravity.step_status": record.status,
      "antigravity.source": record.source,
    },
    source_ref: {
      kind: "antigravity-transcript",
      location: `transcript.jsonl#${record.line}`,
    },
  };
}

function childConversationIds(content?: string): string[] {
  if (!content) return [];
  return [...new Set(content.match(UUID)?.map((value) => value.toLowerCase()) ?? [])];
}

function toolNameForResult(
  type: string,
  pendingTools: readonly PendingAntigravityTool[],
): string | undefined {
  const known: Record<string, string> = {
    VIEW_FILE: "view_file",
    LIST_DIRECTORY: "list_dir",
    FIND_BY_NAME: "find_by_name",
    GREP_SEARCH: "grep_search",
    RUN_COMMAND: "run_command",
    INVOKE_SUBAGENT: "invoke_subagent",
    MANAGE_SUBAGENTS: "manage_subagents",
    READ_URL_CONTENT: "read_url_content",
    SEARCH_WEB: "search_web",
  };
  if (known[type]) return known[type];
  if (type === "CODE_ACTION") {
    return pendingTools.find((tool) => [
      "write_to_file",
      "replace_file_content",
      "multi_replace_file_content",
    ].includes(tool.name))?.name;
  }
  return undefined;
}

function durationMs(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  const safe = Object.fromEntries(
    Object.entries(args).filter(([key]) => !["CodeContent", "ReplacementContent"].includes(key)),
  );
  return summarize(safe);
}

function summarize(value: unknown): string {
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  return text.length <= 2_000 ? text : `${text.slice(0, 1_997)}...`;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
