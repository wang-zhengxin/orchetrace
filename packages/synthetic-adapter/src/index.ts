import {
  defineAdapter,
  type AcknowledgedCanonicalEventSink,
  type PassiveRuntimeObserver,
} from "../../adapter-runtime/src/index.ts";
import type { CanonicalEvent, RuntimeDescriptor } from "../../protocol-ts/src/index.ts";

export interface SyntheticAdapterOptions {
  sourceId?: string;
  sessionId?: string;
  now?: string;
}

export const syntheticRuntimeDescriptor: RuntimeDescriptor = {
  id: "synthetic-runtime",
  label: "Synthetic Runtime",
  shortLabel: "SYNTH",
  accent: "#bb86fc",
  aliases: [],
  sessionDirectory: "memory://sessions",
  capabilities: ["stream", "subagents", "tools"],
  observer: {
    package: "synthetic-adapter",
    entrypoint: "src/index.ts",
    scriptEnv: "ORCHETRACE_SYNTHETIC_SCRIPT",
    sessionsEnv: "ORCHETRACE_SYNTHETIC_SESSIONS",
    directoryFlag: "--sessions-dir",
    stateDirectory: "synthetic-auto",
  },
};

export const syntheticAdapter = defineAdapter<SyntheticAdapterOptions>({
  protocolVersion: 1,
  runtime: "synthetic-runtime",
  descriptor: syntheticRuntimeDescriptor,
  create: (sink, options) => new SyntheticObserver(sink, options),
});

class SyntheticObserver implements PassiveRuntimeObserver {
  private emitted = false;
  private readonly sink: AcknowledgedCanonicalEventSink;
  private readonly options: SyntheticAdapterOptions;

  constructor(
    sink: AcknowledgedCanonicalEventSink,
    options: SyntheticAdapterOptions,
  ) {
    this.sink = sink;
    this.options = options;
  }

  async start(): Promise<{ emitted: number }> {
    return this.scanOnce();
  }

  async scanOnce(): Promise<{ emitted: number }> {
    if (this.emitted) return { emitted: 0 };
    this.emitted = true;
    const sourceId = this.options.sourceId ?? "synthetic-local";
    const sessionId = this.options.sessionId ?? "synthetic-root";
    const observedAt = this.options.now ?? "2026-01-01T00:00:00.000Z";
    const events: CanonicalEvent[] = [
      event(sourceId, sessionId, 1, "session.discovered", observedAt, { label: "Synthetic run" }),
      event(sourceId, sessionId, 2, "agent.status_changed", observedAt, { status: "running" }),
      event(sourceId, "synthetic-child", 3, "agent.spawned", observedAt, { agent_id: "synthetic-child", role: "worker" }, sessionId),
      event(sourceId, "synthetic-child", 4, "tool.started", observedAt, {
        call_id: "fixture-1",
        name: "fixture",
      }, sessionId),
    ];
    for (const item of events) await this.sink.write(item);
    await this.sink.whenIdle();
    return { emitted: events.length };
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

function event(
  sourceId: string,
  sessionId: string,
  sourceSeq: number,
  type: CanonicalEvent["type"],
  observedAt: string,
  data: Record<string, unknown>,
  parentSessionId?: string,
): CanonicalEvent {
  return {
    schema_version: 1,
    event_id: `${sourceId}:${sourceSeq}`,
    runtime: "synthetic-runtime",
    source_id: sourceId,
    session_id: sessionId,
    ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
    source_seq: sourceSeq,
    observed_at: observedAt,
    occurred_at: observedAt,
    type,
    data,
  };
}
