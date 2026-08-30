import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { NdjsonTcpSink } from "../src/index.ts";
import type { NdjsonSocket } from "../src/index.ts";
import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";

test("NDJSON sink pipelines a bounded window and drains ordered acknowledgements", async () => {
  const received: string[] = [];
  let bufferedBeforeFirstAck = 0;
  const socket = new FakeSocket((frame) => {
    if (frame.kind === "hello") return;
    received.push(String(frame.event_id));
    if (received.length === 3) {
      bufferedBeforeFirstAck = received.length;
      for (const eventId of received) socket.ack(eventId);
    } else if (received.length > 3) {
      socket.ack(String(frame.event_id));
    }
  });
  const sink = new NdjsonTcpSink({
    token: "test-token",
    port: 43117,
    maxInFlight: 3,
    reconnectMinMs: 10,
    socketFactory: () => socket,
  });
  try {
    for (let index = 1; index <= 5; index += 1) sink.write(event(index));
    await sink.whenIdle(5_000);
    assert.equal(bufferedBeforeFirstAck, 3);
    assert.deepEqual(received, ["event-1", "event-2", "event-3", "event-4", "event-5"]);
  } finally {
    await sink.close();
  }
});

test("NDJSON sink waits for drain before extending the in-flight window", async () => {
  const received: string[] = [];
  const socket = new FakeSocket((frame) => {
    if (frame.kind === "hello") return;
    received.push(String(frame.event_id));
  }, 1);
  const sink = new NdjsonTcpSink({
    token: "test-token",
    maxInFlight: 3,
    socketFactory: () => socket,
  });
  try {
    sink.write(event(1));
    sink.write(event(2));
    sink.write(event(3));
    await tick();
    assert.deepEqual(received, ["event-1"]);

    socket.releaseBackpressure();
    await tick();
    assert.deepEqual(received, ["event-1", "event-2", "event-3"]);
    for (const eventId of received) socket.ack(eventId);
    await sink.whenIdle(5_000);
  } finally {
    await sink.close();
  }
});

class FakeSocket extends EventEmitter implements NdjsonSocket {
  readyState = "opening";
  private destroyed = false;
  private eventWrites = 0;
  private readonly receiveFrame: (frame: Record<string, unknown>) => void;
  private readonly blockAfterEventWrites?: number;

  constructor(
    receiveFrame: (frame: Record<string, unknown>) => void,
    blockAfterEventWrites?: number,
  ) {
    super();
    this.receiveFrame = receiveFrame;
    this.blockAfterEventWrites = blockAfterEventWrites;
    queueMicrotask(() => {
      this.readyState = "open";
      this.emit("connect");
    });
  }

  setNoDelay(): this { return this; }
  setEncoding(): this { return this; }

  write(data: string): boolean {
    let writable = true;
    for (const line of data.trim().split("\n")) {
      const frame = JSON.parse(line);
      this.receiveFrame(frame);
      if (frame.kind !== "hello") {
        this.eventWrites += 1;
        if (this.eventWrites === this.blockAfterEventWrites) writable = false;
      }
    }
    return writable;
  }

  releaseBackpressure(): void { this.emit("drain"); }

  ack(eventId: string): void {
    queueMicrotask(() => this.emit("data", `${JSON.stringify({ kind: "ack", event_id: eventId })}\n`));
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readyState = "closed";
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function event(index: number): CanonicalEvent {
  return {
    schema_version: 1,
    event_id: `event-${index}`,
    runtime: "synthetic-runtime",
    source_id: "pipeline-test",
    session_id: "root",
    source_seq: index,
    observed_at: "2026-01-01T00:00:00.000Z",
    type: "session.metadata_changed",
    data: { index },
  };
}
