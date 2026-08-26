export type RuntimeKind = "claude-code" | "pi" | "deepseek-harness";

export type CanonicalEventType =
  | "session.discovered"
  | "session.metadata_changed"
  | "agent.spawned"
  | "agent.activation_started"
  | "agent.status_changed"
  | "agent.activation_ended"
  | "agent.outcome_recorded"
  | "agent.disposed"
  | "prompt.accepted"
  | "turn.started"
  | "turn.ended"
  | "step.started"
  | "step.ended"
  | "assistant.message"
  | "assistant.reasoning_summary"
  | "tool.started"
  | "tool.progressed"
  | "tool.finished"
  | "context.compacted"
  | "error.recorded";

export type ActivityStatus =
  | "running"
  | "idle"
  | "waiting"
  | "ready"
  | "inactive"
  | "unknown";

export type TerminalOutcome =
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "unavailable";

export interface CanonicalEvent {
  schema_version: 1;
  event_id: string;
  runtime: RuntimeKind;
  source_id: string;
  session_id: string;
  parent_session_id?: string;
  source_seq: number;
  observed_at: string;
  occurred_at?: string;
  type: CanonicalEventType;
  data: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  source_ref?: {
    kind: string;
    location: string;
  };
  supersedes_event_id?: string;
  ignorable?: boolean;
}
