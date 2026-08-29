export type KnownRuntimeKind = "claude-code" | "pi" | "deepseek-harness" | "codex";
export type RuntimeKind = KnownRuntimeKind | (string & {});

export interface RuntimeDescriptor {
  id: RuntimeKind;
  label: string;
  shortLabel: string;
  accent: string;
  sessionDirectory?: string;
  capabilities: readonly ("passive" | "stream" | "subagents" | "tools" | "usage")[];
}

const knownRuntimes = new Map<KnownRuntimeKind, RuntimeDescriptor>([
  ["claude-code", {
    id: "claude-code", label: "Claude Code", shortLabel: "CLAUDE", accent: "#d6a56f",
    sessionDirectory: "~/.claude/projects", capabilities: ["passive", "subagents", "tools", "usage"],
  }],
  ["pi", {
    id: "pi", label: "Pi", shortLabel: "PI", accent: "#e4c400",
    sessionDirectory: "~/.pi/agent/sessions", capabilities: ["passive", "stream", "subagents", "tools", "usage"],
  }],
  ["deepseek-harness", {
    id: "deepseek-harness", label: "DeepSeek Harness", shortLabel: "HARNESS", accent: "#6aa9ff",
    sessionDirectory: "~/.dsh/sessions", capabilities: ["passive", "stream", "subagents", "tools", "usage"],
  }],
  ["codex", {
    id: "codex", label: "Codex", shortLabel: "CODEX", accent: "#72d6a0",
    sessionDirectory: "~/.codex/sessions", capabilities: ["passive", "stream", "subagents", "tools", "usage"],
  }],
]);

export function runtimeDescriptor(runtime: RuntimeKind): RuntimeDescriptor {
  const known = knownRuntimes.get(runtime as KnownRuntimeKind);
  if (known) return known;
  const label = runtime.replace(/[-_]+/g, " ").trim() || "Unknown";
  return {
    id: runtime,
    label,
    shortLabel: label.slice(0, 12).toUpperCase(),
    accent: "#8f9490",
    capabilities: [],
  };
}

export function registeredRuntimes(): RuntimeDescriptor[] {
  return [...knownRuntimes.values()];
}

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
