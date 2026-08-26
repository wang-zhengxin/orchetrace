import type { CanonicalEvent, CanonicalEventType } from "../../protocol-ts/src/index.ts";
import type { PiDiagnostic } from "./types.ts";

export interface PiRpcMapperOptions {
  sourceId: string;
  sessionId: string;
  eventEpoch?: number;
  onDiagnostic?: (diagnostic: PiDiagnostic) => void;
}

/** Stateful mapper for Pi's authoritative RPC lifecycle stream. */
export class PiRpcMapper {
  private sequence = 0;
  private activationCounter = 0;
  private activationId?: string;
  private readonly options: PiRpcMapperOptions;

  constructor(options: PiRpcMapperOptions) {
    this.options = options;
  }

  map(value: unknown, observedAt: string): CanonicalEvent[] {
    if (!isRecord(value) || typeof value.type !== "string") {
      this.diagnostic("error", "rpc-event-invalid", "Pi RPC event requires a string type");
      return [];
    }
    const at = normalizeTime(observedAt);
    if (!at) {
      this.diagnostic("error", "rpc-time-invalid", "Pi RPC observation time is invalid");
      return [];
    }
    const type = value.type;
    if (type === "agent_start") {
      this.activationCounter += 1;
      this.activationId = `rpc:${this.options.eventEpoch ?? 0}:${this.activationCounter}`;
      return [this.event(at, "agent.activation_started", { activation_id: this.activationId })];
    }
    if (type === "agent_end") {
      return value.willRetry === true
        ? [this.event(at, "agent.status_changed", { status: "waiting", evidence: "Pi agent_end willRetry=true" })]
        : [];
    }
    if (type === "agent_settled") {
      if (!this.activationId) {
        this.diagnostic("warning", "rpc-settled-without-start", "Pi agent_settled has no observed agent_start");
        return [this.event(at, "agent.status_changed", { status: "idle", evidence: "Pi agent_settled" })];
      }
      const event = this.event(at, "agent.activation_ended", {
        activation_id: this.activationId,
        status: "idle",
        evidence: "Pi agent_settled",
      });
      this.activationId = undefined;
      return [event];
    }
    if (type === "turn_start") return [this.event(at, "turn.started", {})];
    if (type === "turn_end") return [this.event(at, "turn.ended", {})];
    if (type === "message_end") return this.mapMessage(value.message, at);
    if (type === "tool_execution_start") {
      const callId = stringField(value, "toolCallId");
      const name = stringField(value, "toolName");
      if (!callId || !name) return this.invalidTool(type);
      return [
        this.event(at, "tool.started", {
          call_id: callId,
          name,
          input_summary: summarize(value.args),
        }),
      ];
    }
    if (type === "tool_execution_update") {
      const callId = stringField(value, "toolCallId");
      const name = stringField(value, "toolName");
      if (!callId || !name) return this.invalidTool(type);
      return [
        this.event(at, "tool.progressed", {
          call_id: callId,
          name,
          output_summary: summarize(record(value.partialResult)?.content),
        }),
      ];
    }
    if (type === "tool_execution_end") {
      const callId = stringField(value, "toolCallId");
      const name = stringField(value, "toolName");
      if (!callId || !name) return this.invalidTool(type);
      return [
        this.event(at, "tool.finished", {
          call_id: callId,
          name,
          outcome: value.isError === true ? "failed" : "succeeded",
          output_summary: summarize(record(value.result)?.content),
        }),
      ];
    }
    if (type === "compaction_start") {
      return [
        this.event(at, "step.started", {
          step_id: `compaction:${this.sequence}`,
          kind: "compaction",
          reason: value.reason,
        }),
      ];
    }
    if (type === "compaction_end") {
      if (value.aborted === true) return [];
      const result = record(value.result);
      return [
        this.event(at, "context.compacted", {
          reason: value.reason,
          summary: summarize(result?.summary),
          first_kept_entry_id: result?.firstKeptEntryId,
          tokens_before: result?.tokensBefore,
          estimated_tokens_after: result?.estimatedTokensAfter,
        }),
      ];
    }
    if (type === "extension_error") {
      return [
        this.event(at, "error.recorded", {
          category: "extension",
          message: stringField(value, "message") ?? "Pi extension error",
        }),
      ];
    }
    if (
      [
        "message_start",
        "message_update",
        "queue_update",
        "bash_execution_update",
        "auto_retry_start",
        "auto_retry_end",
        "summarization_retry_scheduled",
        "summarization_retry_attempt_start",
        "summarization_retry_finished",
      ].includes(type)
    ) {
      return [];
    }
    this.diagnostic("warning", "rpc-event-unknown", `unsupported Pi RPC event type ${type}`);
    return [];
  }

  private mapMessage(value: unknown, at: string): CanonicalEvent[] {
    const message = record(value);
    if (!message) return [];
    const occurredAt = messageTime(message) ?? at;
    const role = stringField(message, "role");
    if (role === "user") {
      return [this.event(at, "prompt.accepted", { excerpt: summarize(message.content), source: "user" }, occurredAt)];
    }
    if (role !== "assistant") return [];
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = summarize(blocks.filter((item) => record(item)?.type === "text"));
    const thinking = summarize(blocks.filter((item) => record(item)?.type === "thinking"));
    return [
      ...(text ? [this.event(at, "assistant.message", { summary: text, usage: message.usage }, occurredAt)] : []),
      ...(thinking ? [this.event(at, "assistant.reasoning_summary", { summary: thinking }, occurredAt)] : []),
    ];
  }

  private invalidTool(type: string): CanonicalEvent[] {
    this.diagnostic("error", "rpc-tool-invalid", `${type} requires toolCallId and toolName`);
    return [];
  }

  private event(
    at: string,
    type: CanonicalEventType,
    data: Record<string, unknown>,
    occurredAt = at,
  ): CanonicalEvent {
    const sequence = this.sequence;
    this.sequence += 1;
    const epoch = this.options.eventEpoch ?? 0;
    return {
      schema_version: 1,
      event_id: `pi-rpc:${encodeURIComponent(this.options.sourceId)}:${encodeURIComponent(this.options.sessionId)}:${epoch}:${sequence}:${type}`,
      runtime: "pi",
      source_id: this.options.sourceId,
      session_id: this.options.sessionId,
      source_seq: sequence,
      observed_at: at,
      occurred_at: occurredAt,
      type,
      data: compact(data),
      source_ref: { kind: "pi-rpc", location: `rpc:${epoch}#${sequence}` },
    };
  }

  private diagnostic(level: "warning" | "error", code: string, message: string): void {
    this.options.onDiagnostic?.({ level, code, location: `rpc#${this.sequence}`, message });
  }
}

function messageTime(message: Record<string, unknown>): string | undefined {
  const value = message.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string") return normalizeTime(value);
  return undefined;
}

function normalizeTime(value: string): string | undefined {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function summarize(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.map((item) => summarize(record(item)?.text ?? item)).join(" ")
        : value === undefined || value === null
          ? ""
          : JSON.stringify(value);
  return raw.replace(/\s+/g, " ").trim().slice(0, 500);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
