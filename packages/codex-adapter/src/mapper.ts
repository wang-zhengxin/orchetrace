import type { CanonicalEvent, CanonicalEventType, TerminalOutcome } from "../../protocol-ts/src/index.ts";
import type { CodexMapContext, CodexRolloutRecord, CodexSessionIdentity } from "./types.ts";

export function identityFromSessionMeta(payload: Record<string, unknown>): CodexSessionIdentity | undefined {
  const sessionId = stringValue(payload.id) ?? stringValue(payload.session_id);
  if (!sessionId) return undefined;
  const source = objectValue(payload.source);
  const subagent = objectValue(source?.subagent);
  const spawn = objectValue(subagent?.thread_spawn);
  const parentSessionId = stringValue(spawn?.parent_thread_id);
  const agentPath = stringValue(spawn?.agent_path);
  const nickname = stringValue(spawn?.agent_nickname);
  const role = stringValue(spawn?.agent_role) ?? stringValue(subagent?.other);
  const depth = numberValue(spawn?.depth) ?? (parentSessionId ? 1 : 0);
  return {
    sessionId,
    ...(parentSessionId ? { parentSessionId } : {}),
    label: nickname ?? lastPathComponent(agentPath) ?? (parentSessionId ? "subagent" : "codex"),
    ...(role ? { role } : {}),
    ...(stringValue(payload.model_provider) ? { provider: stringValue(payload.model_provider)! } : {}),
    ...(stringValue(payload.cwd) ? { cwd: stringValue(payload.cwd)! } : {}),
    depth,
    origin: parentSessionId ? "subagent" : "root",
  };
}

export function mapCodexRecord(record: CodexRolloutRecord, context: CodexMapContext): CanonicalEvent[] {
  const payloadType = stringValue(record.payload.type);
  if (record.type === "session_meta") return sessionEvents(record, context);
  if (record.type === "turn_context") {
    const model = stringValue(record.payload.model);
    return model
      ? [event(record, context, "metadata", "session.metadata_changed", { model })]
      : [];
  }
  if (record.type === "event_msg") return eventMessage(record, context, payloadType);
  if (record.type === "response_item") return responseItem(record, context, payloadType);
  if (record.type === "compacted") {
    return [event(record, context, "compacted", "context.compacted", {
      summary: stringValue(record.payload.message) ?? "Codex context compacted",
    })];
  }
  return [];
}

function sessionEvents(record: CodexRolloutRecord, context: CodexMapContext): CanonicalEvent[] {
  const identity = context.identity;
  const data = {
    label: identity.label,
    role: identity.role ?? (identity.origin === "root" ? "orchestrator" : "subagent"),
    mode: identity.origin === "root" ? "root" : "continuable",
    provider: identity.provider ?? "openai",
    model: identity.model ?? "codex",
    cwd: identity.cwd,
    delegation_depth: identity.depth,
    origin: identity.origin,
  };
  if (context.headerLine !== undefined && record.line !== context.headerLine) {
    return [event(record, context, "metadata", "session.metadata_changed", compact({
      model: stringValue(record.payload.model),
      provider: stringValue(record.payload.model_provider),
      cwd: stringValue(record.payload.cwd),
    }))];
  }
  const discovered = event(record, context, "session", "session.discovered", compact(data));
  return identity.parentSessionId
    ? [discovered, event(record, context, "spawn", "agent.spawned", compact(data))]
    : [discovered];
}

function eventMessage(
  record: CodexRolloutRecord,
  context: CodexMapContext,
  type?: string,
): CanonicalEvent[] {
  switch (type) {
    case "task_started": {
      const activationId = stringValue(record.payload.turn_id) ?? `turn-${record.line}`;
      return [
        event(record, context, "activation", "agent.activation_started", { activation_id: activationId }),
        event(record, context, "turn", "turn.started", { turn_id: activationId }),
      ];
    }
    case "task_complete": {
      const turnId = stringValue(record.payload.turn_id) ?? `turn-${record.line}`;
      const message = stringValue(record.payload.last_agent_message);
      return [
        ...(message ? [event(record, context, "message", "assistant.message", { summary: message })] : []),
        event(record, context, "turn", "turn.ended", { turn_id: turnId, outcome: "succeeded" }),
        event(record, context, "outcome", "agent.outcome_recorded", {
          outcome: "succeeded",
          evidence: message ?? "Codex reported task_complete",
        }),
        event(record, context, "activation", "agent.activation_ended", {
          activation_id: turnId,
          status: "inactive",
        }),
      ];
    }
    case "turn_aborted":
      return terminalEvents(record, context, "interrupted", stringValue(record.payload.reason));
    case "user_message":
      return [event(record, context, "prompt", "prompt.accepted", {
        excerpt: stringValue(record.payload.message) ?? "",
        source: "user",
      })];
    case "agent_message":
      return [event(record, context, "message", "assistant.message", {
        summary: stringValue(record.payload.message) ?? "",
      })];
    case "agent_reasoning":
      return [event(record, context, "reasoning", "assistant.reasoning_summary", {
        summary: stringValue(record.payload.text) ?? stringValue(record.payload.message) ?? "",
      })];
    case "context_compacted":
      return [event(record, context, "compacted", "context.compacted", {
        summary: "Codex context compacted",
      })];
    case "patch_apply_end":
    case "mcp_tool_call_end":
    case "web_search_end": {
      const callId = stringValue(record.payload.call_id) ?? `${type}-${record.line}`;
      const success = booleanValue(record.payload.success) ?? stringValue(record.payload.status) !== "failed";
      return [event(record, context, `tool-${callId}`, "tool.finished", {
        call_id: callId,
        name: toolName(type, record.payload),
        outcome: success ? "succeeded" : "failed",
        duration_ms: durationMs(record.payload),
        output_summary: summarize(record.payload.result ?? record.payload.stderr ?? record.payload.stdout),
      })];
    }
    default:
      return [];
  }
}

function responseItem(
  record: CodexRolloutRecord,
  context: CodexMapContext,
  type?: string,
): CanonicalEvent[] {
  switch (type) {
    case "custom_tool_call":
    case "function_call": {
      const callId = stringValue(record.payload.call_id) ?? stringValue(record.payload.id) ?? `call-${record.line}`;
      return [event(record, context, `tool-${callId}`, "tool.started", {
        call_id: callId,
        name: stringValue(record.payload.name) ?? "tool",
        input_summary: summarize(record.payload.input ?? record.payload.arguments),
      })];
    }
    case "custom_tool_call_output":
    case "function_call_output": {
      const callId = stringValue(record.payload.call_id) ?? `call-${record.line}`;
      const output = record.payload.output;
      return [event(record, context, `tool-${callId}`, "tool.finished", {
        call_id: callId,
        name: "tool",
        outcome: outputLooksFailed(output) ? "failed" : "succeeded",
        output_summary: summarize(output),
      })];
    }
    case "message": {
      const role = stringValue(record.payload.role);
      const content = textContent(record.payload.content);
      if (role === "user") {
        return [event(record, context, "prompt", "prompt.accepted", { excerpt: content, source: "user" })];
      }
      if (role === "assistant") {
        return [event(record, context, "message", "assistant.message", { summary: content })];
      }
      return [];
    }
    case "reasoning": {
      const summary = textContent(record.payload.summary);
      return summary
        ? [event(record, context, "reasoning", "assistant.reasoning_summary", { summary })]
        : [];
    }
    default:
      return [];
  }
}

function terminalEvents(
  record: CodexRolloutRecord,
  context: CodexMapContext,
  outcome: TerminalOutcome,
  evidence?: string,
): CanonicalEvent[] {
  const turnId = stringValue(record.payload.turn_id) ?? `turn-${record.line}`;
  const terminalEvidence = evidence ?? `Codex turn ${outcome}`;
  return [
    event(record, context, "error", "error.recorded", {
      category: "runtime",
      message: terminalEvidence,
    }),
    event(record, context, "turn", "turn.ended", { turn_id: turnId, outcome }),
    event(record, context, "outcome", "agent.outcome_recorded", { outcome, evidence: terminalEvidence }),
    event(record, context, "activation", "agent.activation_ended", {
      activation_id: turnId,
      status: "inactive",
    }),
  ];
}

function event(
  record: CodexRolloutRecord,
  context: CodexMapContext,
  suffix: string,
  type: CanonicalEventType,
  data: Record<string, unknown>,
): CanonicalEvent {
  return {
    schema_version: 1,
    event_id: `codex:${encodeURIComponent(context.sourceId)}:${encodeURIComponent(context.identity.sessionId)}:${record.line}:${suffix}`,
    runtime: "codex",
    source_id: context.sourceId,
    session_id: context.identity.sessionId,
    ...(context.identity.parentSessionId ? { parent_session_id: context.identity.parentSessionId } : {}),
    source_seq: record.line,
    observed_at: record.timestamp,
    occurred_at: record.timestamp,
    type,
    data: compact(data),
    attributes: {
      "codex.record_type": record.type,
      ...(stringValue(record.payload.type) ? { "codex.payload_type": stringValue(record.payload.type)! } : {}),
    },
    source_ref: { kind: "codex-rollout", location: `rollout#${record.line}` },
  };
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function durationMs(payload: Record<string, unknown>): number | undefined {
  const direct = numberValue(payload.duration_ms);
  if (direct !== undefined) return direct;
  const seconds = numberValue(payload.duration);
  return seconds === undefined ? undefined : Math.round(seconds * 1_000);
}

function lastPathComponent(path?: string): string | undefined {
  if (!path) return undefined;
  return path.split("/").filter(Boolean).at(-1);
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      const record = objectValue(item);
      return stringValue(record?.text) ?? stringValue(record?.content) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarize(value: unknown): string {
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  return text.length <= 2_000 ? text : `${text.slice(0, 1_997)}...`;
}

function outputLooksFailed(value: unknown): boolean {
  const record = objectValue(value);
  if (booleanValue(record?.success) === false) return true;
  const status = stringValue(record?.status)?.toLowerCase();
  return status === "failed" || status === "error";
}

function toolName(type: string, payload: Record<string, unknown>): string {
  if (type === "patch_apply_end") return "apply_patch";
  if (type === "web_search_end") return "web_search";
  return stringValue(objectValue(payload.invocation)?.tool) ?? "mcp";
}
