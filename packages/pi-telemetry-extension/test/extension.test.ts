import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import extension, { emitPiAgentTelemetry } from "../src/index.ts";

class FakeBus {
  private readonly emitter = new EventEmitter();

  emit(channel: string, data: unknown): void {
    this.emitter.emit(channel, data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    this.emitter.on(channel, handler);
    return () => this.emitter.off(channel, handler);
  }
}

test("extension persists validated bus telemetry and unsubscribes on shutdown", () => {
  const events = new FakeBus();
  const entries: Array<{ customType: string; data: unknown }> = [];
  let shutdown = () => undefined;
  const pi = {
    events,
    appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
    on: (_event: "session_shutdown", handler: () => void) => {
      shutdown = handler;
    },
  };
  extension(pi);
  emitPiAgentTelemetry(pi, {
    schema_version: 1,
    event_id: "worker:discover",
    occurred_at: "2026-08-26T05:00:00.000Z",
    kind: "agent.discovered",
    agent_id: "worker-1",
    label: "Worker",
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.customType, "orchetrace.telemetry");
  shutdown();
  emitPiAgentTelemetry(pi, {
    schema_version: 1,
    event_id: "worker:start",
    occurred_at: "2026-08-26T05:00:01.000Z",
    kind: "activation.started",
    agent_id: "worker-1",
    activation_id: "a1",
  });
  assert.equal(entries.length, 1);
});

test("producer rejects malformed telemetry before it reaches the shared bus", () => {
  const events = new FakeBus();
  assert.throws(
    () =>
      emitPiAgentTelemetry({ events } as never, {
        schema_version: 1,
        event_id: "bad",
        occurred_at: "not-a-time",
        kind: "agent.disposed",
        agent_id: "bad id",
      }),
    /valid event_id/,
  );
});
