import { GENERATED_RUNTIME_DESCRIPTORS } from "./generated-runtime-registry.ts";

export type KnownRuntimeKind = (typeof GENERATED_RUNTIME_DESCRIPTORS)[number]["id"];
export type RuntimeKind = KnownRuntimeKind | (string & {});
export type RuntimeCapability = "passive" | "stream" | "subagents" | "tools" | "usage" | "hooks";

export interface RuntimeObserverDescriptor {
  package: string;
  entrypoint: string;
  scriptEnv: string;
  sessionsEnv: string;
  directoryFlag: string;
  stateDirectory: string;
}

export interface RuntimeDescriptor {
  id: RuntimeKind;
  label: string;
  shortLabel: string;
  accent: string;
  aliases: readonly string[];
  sessionDirectory: string;
  capabilities: readonly RuntimeCapability[];
  observer: RuntimeObserverDescriptor;
}

const registered = GENERATED_RUNTIME_DESCRIPTORS as readonly RuntimeDescriptor[];
const knownRuntimes = new Map<string, RuntimeDescriptor>();
for (const descriptor of registered) {
  knownRuntimes.set(descriptor.id, descriptor);
  for (const alias of descriptor.aliases) knownRuntimes.set(alias, descriptor);
}

export function runtimeDescriptor(runtime: RuntimeKind): RuntimeDescriptor {
  const known = knownRuntimes.get(runtime);
  if (known) return known;
  const label = runtime.replace(/[-_]+/g, " ").trim() || "Unknown";
  return {
    id: runtime,
    label,
    shortLabel: label.slice(0, 12).toUpperCase(),
    accent: "#8f9490",
    aliases: [],
    sessionDirectory: "—",
    capabilities: [],
    observer: {
      package: "",
      entrypoint: "",
      scriptEnv: "",
      sessionsEnv: "",
      directoryFlag: "--sessions-dir",
      stateDirectory: runtime,
    },
  };
}

export function registeredRuntimes(): RuntimeDescriptor[] {
  return [...registered];
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
