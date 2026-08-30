import {
  runtimeDescriptor,
  type CanonicalEvent,
  type RuntimeDescriptor,
  type RuntimeKind,
} from "../../protocol-ts/src/index.ts";
import type { AcknowledgedCanonicalEventSink } from "./ndjson-sink.ts";

export interface PassiveRuntimeObserver {
  start(): Promise<unknown>;
  scanOnce(): Promise<unknown>;
  stop(): Promise<void>;
}

export interface AdapterRuntimeContext {
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: { level: "warning" | "error"; code?: string; message: string }) => void;
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
    const previous = sequences.get(event.source_id);
    if (previous !== undefined && event.source_seq <= previous) {
      throw new AdapterConformanceError(
        `source_seq for ${event.source_id} must increase (${event.source_seq} <= ${previous})`,
      );
    }
    sequences.set(event.source_id, event.source_seq);
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
