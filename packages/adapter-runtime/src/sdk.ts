import {
  runtimeDescriptor,
  type CanonicalEvent,
  type RuntimeDescriptor,
  type RuntimeKind,
} from "../../protocol-ts/src/index.ts";
import type { AcknowledgedCanonicalEventSink } from "./ndjson-sink.ts";

const ACTIVITY_STATUSES = new Set(["running", "idle", "waiting", "ready", "inactive", "unknown"]);
const TERMINAL_OUTCOMES = new Set(["succeeded", "failed", "interrupted", "cancelled", "unavailable"]);

export interface PassiveRuntimeObserver {
  start(): Promise<unknown>;
  scanOnce(): Promise<unknown>;
  stop(): Promise<void>;
}

export interface AdapterRuntimeContext {
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: {
    level: "warning" | "error";
    code?: string;
    location?: string;
    message: string;
  }) => void;
}

export interface AdapterPluginDefinition<Options> {
  protocolVersion: 1;
  runtime: RuntimeKind;
  descriptor?: RuntimeDescriptor;
  create(
    sink: AcknowledgedCanonicalEventSink,
    options: Options,
    context?: AdapterRuntimeContext,
  ): PassiveRuntimeObserver;
}

export interface AdapterPlugin<Options> extends AdapterPluginDefinition<Options> {
  descriptor: RuntimeDescriptor;
}

export type AdapterDefinition<Options> = AdapterPluginDefinition<Options>;

export interface AdapterConformanceReport {
  runtime: RuntimeKind;
  eventCount: number;
  sessionCount: number;
  sourceCount: number;
  eventTypes: string[];
}

export class AdapterConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterConformanceError";
  }
}

export function defineAdapter<Options>(definition: AdapterPluginDefinition<Options>): AdapterPlugin<Options> {
  if (definition.protocolVersion !== 1) {
    throw new AdapterConformanceError(`unsupported adapter protocol ${definition.protocolVersion}`);
  }
  const descriptor = definition.descriptor ?? runtimeDescriptor(definition.runtime);
  if (descriptor.id !== definition.runtime) {
    throw new AdapterConformanceError(
      `adapter runtime ${definition.runtime} does not match descriptor ${descriptor.id}`,
    );
  }
  if (!descriptor.id || !descriptor.label || !descriptor.shortLabel) {
    throw new AdapterConformanceError("adapter descriptor must provide id, label, and shortLabel");
  }
  return Object.freeze({ ...definition, descriptor });
}

export function assertCanonicalEventContract(event: CanonicalEvent, runtime: RuntimeKind): void {
  if (event.schema_version !== 1) throw new AdapterConformanceError(`unsupported event schema ${event.schema_version}`);
  if (event.runtime !== runtime) {
    throw new AdapterConformanceError(`event ${event.event_id} uses runtime ${event.runtime}; expected ${runtime}`);
  }
  for (const [field, value] of [
    ["event_id", event.event_id],
    ["source_id", event.source_id],
    ["session_id", event.session_id],
    ["observed_at", event.observed_at],
  ]) {
    if (typeof value !== "string" || !value.trim()) {
      throw new AdapterConformanceError(`event requires non-empty ${field}`);
    }
  }
  if (!Number.isSafeInteger(event.source_seq) || event.source_seq < 0) {
    throw new AdapterConformanceError(`event ${event.event_id} has invalid source_seq`);
  }
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    throw new AdapterConformanceError(`event ${event.event_id} data must be an object`);
  }
  assertCanonicalLifecycleContract(event);
}

/** Validate the runtime-independent semantics shared by every adapter. */
export function assertCanonicalLifecycleContract(event: CanonicalEvent): void {
  assertTimestamp(event, "observed_at", event.observed_at);
  if (event.occurred_at !== undefined) assertTimestamp(event, "occurred_at", event.occurred_at);
  if (event.source_ref !== undefined) {
    assertNonEmpty(event, "source_ref.kind", event.source_ref.kind);
    assertNonEmpty(event, "source_ref.location", event.source_ref.location);
  }
  if (event.supersedes_event_id !== undefined) {
    assertNonEmpty(event, "supersedes_event_id", event.supersedes_event_id);
    if (event.supersedes_event_id === event.event_id) {
      throw new AdapterConformanceError(`event ${event.event_id} cannot supersede itself`);
    }
  }

  switch (event.type) {
    case "agent.spawned":
      assertNonEmpty(event, "parent_session_id", event.parent_session_id);
      break;
    case "agent.activation_started":
    case "agent.activation_ended":
      assertDataString(event, "activation_id");
      if (event.data.status !== undefined) assertStatus(event, event.data.status);
      break;
    case "agent.status_changed":
      assertStatus(event, event.data.status);
      break;
    case "agent.outcome_recorded":
      assertOutcome(event, event.data.outcome);
      assertDataString(event, "evidence");
      break;
    case "tool.started":
    case "tool.progressed":
      assertDataString(event, "call_id");
      assertDataString(event, "name");
      break;
    case "tool.finished":
      assertDataString(event, "call_id");
      assertDataString(event, "name");
      assertOutcome(event, event.data.outcome);
      break;
    case "turn.ended":
    case "step.ended":
      if (event.data.outcome !== undefined) assertOutcome(event, event.data.outcome);
      break;
    case "error.recorded":
      assertDataString(event, "message");
      break;
    default:
      break;
  }
}

export function verifyAdapterConformance<Options>(
  plugin: AdapterPlugin<Options>,
  events: readonly CanonicalEvent[],
): AdapterConformanceReport {
  const identities = new Set<string>();
  const sequences = new Map<string, number>();
  const sessions = new Set<string>();
  const sources = new Set<string>();
  const eventTypes = new Set<string>();
  for (const event of events) {
    assertCanonicalEventContract(event, plugin.runtime);
    if (identities.has(event.event_id)) throw new AdapterConformanceError(`duplicate event_id ${event.event_id}`);
    identities.add(event.event_id);
    // Persisted runtimes allocate sequence numbers per session and source kind;
    // one raw record may legitimately expand into several canonical facts.
    const sequenceKey = `${event.source_id}\u0000${event.session_id}\u0000${event.source_ref?.kind ?? "canonical"}`;
    const previous = sequences.get(sequenceKey);
    if (previous !== undefined && event.source_seq < previous) {
      throw new AdapterConformanceError(
        `source_seq for ${event.source_id}/${event.session_id} must not decrease (${event.source_seq} < ${previous})`,
      );
    }
    sequences.set(sequenceKey, event.source_seq);
    sessions.add(event.session_id);
    sources.add(event.source_id);
    eventTypes.add(event.type);
  }
  return {
    runtime: plugin.runtime,
    eventCount: events.length,
    sessionCount: sessions.size,
    sourceCount: sources.size,
    eventTypes: [...eventTypes].sort(),
  };
}

function assertTimestamp(event: CanonicalEvent, field: string, value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new AdapterConformanceError(`event ${event.event_id} has invalid ${field}`);
  }
}

function assertNonEmpty(event: CanonicalEvent, field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AdapterConformanceError(`event ${event.event_id} requires non-empty ${field}`);
  }
}

function assertDataString(event: CanonicalEvent, field: string): void {
  assertNonEmpty(event, `data.${field}`, event.data[field]);
}

function assertStatus(event: CanonicalEvent, value: unknown): void {
  if (typeof value !== "string" || !ACTIVITY_STATUSES.has(value)) {
    throw new AdapterConformanceError(`event ${event.event_id} has invalid activity status`);
  }
}

function assertOutcome(event: CanonicalEvent, value: unknown): void {
  if (typeof value !== "string" || !TERMINAL_OUTCOMES.has(value)) {
    throw new AdapterConformanceError(`event ${event.event_id} has invalid terminal outcome`);
  }
}

export class MemoryCanonicalEventSink implements AcknowledgedCanonicalEventSink {
  readonly events: CanonicalEvent[] = [];

  write(event: CanonicalEvent): void {
    this.events.push(event);
  }

  whenIdle(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
