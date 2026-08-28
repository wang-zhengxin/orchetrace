import type {
  ActivityStatus,
  CanonicalEvent,
  CanonicalEventType,
  TerminalOutcome,
} from "../../protocol-ts/src/index.ts";

interface SessionHeader {
  id: string;
  parentSession?: string;
  cwd?: string;
  createdAt: number;
  origin?: "subagent";
  delegationDepth?: number;
  agentPreset?: string;
}

interface Descriptor {
  mode: "root" | "one-shot" | "continuable" | "remote";
  label: string;
  role?: string;
  provider?: string;
  model?: string;
  detailLevel?: "full" | "partial" | "opaque";
}

interface DshSessionEvent {
  seq: number;
  time: number;
  type: string;
  data: Record<string, unknown>;
  ignorable?: boolean;
}

export type DshRecord =
  | {
      kind: "session_announced";
      sourceId: string;
      header: SessionHeader;
      descriptor: Descriptor;
    }
  | {
      kind: "session_event";
      sourceId: string;
      sessionId: string;
      parentSessionId?: string;
      event: DshSessionEvent;
    }
  | {
      kind: "agent_status";
      sourceId: string;
      sessionId: string;
      parentSessionId?: string;
      sourceSeq: number;
      time: number;
      status: ActivityStatus;
    }
  | {
      kind: "agent_disposed";
      sourceId: string;
      sessionId: string;
      parentSessionId?: string;
      sourceSeq: number;
      time: number;
    }
  | {
      kind: "activation_started";
      sourceId: string;
      sessionId: string;
      parentSessionId?: string;
      sourceSeq: number;
      time: number;
      activationId: string;
    }
  | {
      kind: "activation_ended";
      sourceId: string;
      sessionId: string;
      parentSessionId?: string;
      sourceSeq: number;
      time: number;
      activationId: string;
      status: ActivityStatus;
    }
  | {
      kind: "agent_outcome";
      sourceId: string;
      sessionId: string;
      parentSessionId?: string;
      sourceSeq: number;
      time: number;
      outcome: TerminalOutcome;
      evidence: string;
    };

export function mapDshRecord(record: DshRecord): CanonicalEvent[] {
  switch (record.kind) {
    case "session_announced": {
      const { header, descriptor } = record;
      const base = eventBase({
        sourceId: record.sourceId,
        sessionId: header.id,
        parentSessionId: header.parentSession,
        sourceSeq: 0,
        time: header.createdAt,
        sourceKind: "session-header",
        sourceLocation: `${header.id}#header`,
      });
      const identity = {
        label: descriptor.label,
        role: descriptor.role,
        mode: descriptor.mode,
        provider: descriptor.provider,
        model: descriptor.model,
        detail_level: descriptor.detailLevel ?? "full",
        cwd: header.cwd,
        delegation_depth: header.delegationDepth ?? 0,
        origin: header.origin ?? (header.parentSession ? "subagent" : "root"),
      };
      const discovered: CanonicalEvent = {
        ...base,
        event_id: `dsh:${record.sourceId}:${header.id}:header`,
        type: "session.discovered",
        data: compact(identity),
      };
      if (!header.parentSession) return [discovered];
      return [
        discovered,
        {
          ...base,
          event_id: `dsh:${record.sourceId}:${header.id}:spawn`,
          type: "agent.spawned",
          data: compact(identity),
        },
      ];
    }
    case "agent_status":
      return [runtimeEvent(record, "agent.status_changed", { status: record.status })];
    case "agent_disposed":
      return [runtimeEvent(record, "agent.disposed", {})];
    case "activation_started":
      return [
        runtimeEvent(record, "agent.activation_started", {
          activation_id: record.activationId,
        }),
      ];
    case "activation_ended":
      return [
        runtimeEvent(record, "agent.activation_ended", {
          activation_id: record.activationId,
          status: record.status,
        }),
      ];
    case "agent_outcome":
      return [
        runtimeEvent(record, "agent.outcome_recorded", {
          outcome: record.outcome,
          evidence: record.evidence,
        }),
      ];
    case "session_event":
      return mapSessionEvent(record);
  }
}

function mapSessionEvent(record: Extract<DshRecord, { kind: "session_event" }>): CanonicalEvent[] {
  const { event } = record;
  const base = eventBase({
    sourceId: record.sourceId,
    sessionId: record.sessionId,
    parentSessionId: record.parentSessionId,
    sourceSeq: event.seq + 1,
    time: event.time,
    sourceKind: "session-event",
    sourceLocation: `${record.sessionId}#${event.seq}`,
  });
  const canonical = (type: CanonicalEventType, data: Record<string, unknown>): CanonicalEvent[] => [
    {
      ...base,
      event_id: `dsh:${record.sourceId}:${record.sessionId}:${event.seq}`,
      type,
      data: compact(data),
      attributes: { dsh_event_type: event.type, dsh_seq: event.seq },
      ignorable: event.ignorable,
    },
  ];

  switch (event.type) {
    case "user/message":
      return canonical("prompt.accepted", {
        excerpt: summarizeText(event.data.content ?? event.data.message),
        source: event.data.source ?? "user",
      });
    case "assistant/message":
      return canonical("assistant.message", {
        summary: summarizeText(event.data.content ?? event.data.message),
        usage: event.data.usage,
      });
    case "turn/start":
      return canonical("turn.started", { turn: event.data.turn });
    case "turn/end":
      return canonical("turn.ended", {
        turn: event.data.turn,
        reason: event.data.reason,
      });
    case "step/start":
      return canonical("step.started", {
        turn: event.data.turn,
        step: event.data.step,
      });
    case "step/end":
      return canonical("step.ended", {
        turn: event.data.turn,
        step: event.data.step,
      });
    case "tool/call":
      return canonical("tool.started", {
        call_id: event.data.callId,
        name: event.data.name,
        input_summary: summarizeToolInput(event.data.arguments),
      });
    case "tool/result": {
      const message = asRecord(event.data.message);
      const source = asRecord(message?.source);
      const callId = event.data.callId ?? source?.callId;
      const failed = Boolean(event.data.isError ?? event.data.error);
      return canonical("tool.finished", {
        call_id: callId,
        name: event.data.name ?? source?.name ?? "tool",
        outcome: failed ? "failed" : "succeeded",
        duration_ms: event.data.durationMs,
        output_summary: summarizeText(event.data.content ?? event.data.message),
      });
    }
    case "subagent/descriptor":
      return canonical("session.metadata_changed", {
        label: event.data.label,
        mode: event.data.mode,
        provider: event.data.agentProvider,
        model: event.data.agentModel,
        subagent_provider: event.data.provider,
      });
    case "session/title":
      return canonical("session.metadata_changed", {
        label: event.data.title,
      });
    case "sandbox/mode":
      return canonical("session.metadata_changed", {
        sandbox_mode: event.data.mode,
      });
    case "approval/policy":
      return canonical("session.metadata_changed", {
        approval_policy: event.data.policy,
      });
    case "permission/preset":
      return canonical("session.metadata_changed", {
        permission_preset: event.data.preset ?? event.data.name,
      });
    case "agent-preset/selected":
      return canonical("session.metadata_changed", {
        agent_preset: event.data.preset ?? event.data.name,
      });
    case "approval/asked":
      return canonical("agent.status_changed", {
        status: "waiting",
        reason: "approval",
      });
    case "approval/decided":
      return canonical("agent.status_changed", {
        status: "running",
        reason: "approval-decided",
        decision: event.data.decision,
      });
    case "compaction/end":
      return canonical("context.compacted", {
        tokens_before: event.data.tokensBefore,
      });
    case "error":
      return canonical("error.recorded", {
        category: event.data.category ?? "runtime",
        message: summarizeText(event.data.message),
      });
    case "assistant/chunk":
    case "todo/write":
    case "request/header":
    case "request/context":
    case "session/end-seed":
    case "agent/inbox/spliced":
    case "session/title-llm-request":
    case "web/deepseek-search-llm-request":
      return [];
    default:
      if (event.ignorable) return [];
      throw new Error(`unsupported required DSH event type: ${event.type}`);
  }
}

function runtimeEvent(
  record: Exclude<DshRecord, { kind: "session_announced" | "session_event" }>,
  type: CanonicalEventType,
  data: Record<string, unknown>,
): CanonicalEvent {
  const base = eventBase({
    sourceId: record.sourceId,
    sessionId: record.sessionId,
    parentSessionId: record.parentSessionId,
    sourceSeq: record.sourceSeq,
    time: record.time,
    sourceKind: "agent-event",
    sourceLocation: `${record.sessionId}@${record.sourceSeq}`,
  });
  return {
    ...base,
    event_id: `dsh:${record.sourceId}:${record.sessionId}:runtime:${record.sourceSeq}:${type}`,
    type,
    data: compact(data),
  };
}

function eventBase(input: {
  sourceId: string;
  sessionId: string;
  parentSessionId?: string;
  sourceSeq: number;
  time: number;
  sourceKind: string;
  sourceLocation: string;
}): Omit<CanonicalEvent, "event_id" | "type" | "data"> {
  const at = new Date(input.time).toISOString();
  return {
    schema_version: 1,
    runtime: "deepseek-harness",
    source_id: input.sourceId,
    session_id: input.sessionId,
    ...(input.parentSessionId ? { parent_session_id: input.parentSessionId } : {}),
    source_seq: input.sourceSeq,
    observed_at: at,
    occurred_at: at,
    source_ref: { kind: input.sourceKind, location: input.sourceLocation },
  };
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function summarizeText(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value
            .map((item) =>
              item && typeof item === "object" && "text" in item
                ? String((item as { text: unknown }).text)
                : "",
            )
            .join(" ")
        : value && typeof value === "object" && "content" in value
          ? summarizeText((value as { content: unknown }).content)
          : String(value ?? "");
  return raw.replace(/\s+/g, " ").trim().slice(0, 180);
}

function summarizeToolInput(value: unknown): string {
  if (typeof value === "string") {
    try {
      return summarizeToolInput(JSON.parse(value));
    } catch {
      return summarizeText(value);
    }
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["description", "command", "query", "path", "prompt"]) {
      if (key in object) return summarizeText(object[key]);
    }
    return summarizeText(JSON.stringify(object));
  }
  return summarizeText(value);
}
